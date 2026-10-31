import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LIVE_SIDS, SECRET_MARKER, defaultAccounts, makePending, sequenceJson } from '@jantar/fixtures';
import { createClaudeFilesSource, createSessionSource } from '../../src/sources/claude-files/index.js';
import { fsx } from '../../src/sources/lib/fsx.js';
import { SID, record, sourceEnv, withRealClock, type SourceEnv } from './helpers.js';

const SLOW = { watch: false, pollMs: 1e9 } as const;

describe('claude-files: discovery', () => {
  let env: SourceEnv;
  beforeEach(async () => {
    env = await sourceEnv();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it('finds the live sessions of every account and drops sdk-cli, reused and dead pids', async () => {
    const src = createClaudeFilesSource(env.ctx, SLOW);
    const recs = await src.scan();
    expect(recs.map((r) => r.sid)).toEqual([...DEFAULT_LIVE_SIDS].sort());
    expect(recs.find((r) => r.sid === SID.sdk)).toBeUndefined();
    expect(recs.find((r) => r.sid === SID.reused)).toBeUndefined();
    expect(recs.find((r) => r.sid === SID.crashed)).toBeUndefined();
    expect(src.current()).toEqual(recs);
  });

  it('tags each session with the account of the config dir it was found under', async () => {
    const recs = await createClaudeFilesSource(env.ctx, SLOW).scan();
    const bySid = Object.fromEntries(recs.map((r) => [r.sid, r]));
    expect(bySid[SID.busy]?.account).toBe(1); // ~/.claude = the default login (account 1 is active)
    expect(bySid[SID.idle]?.account).toBe(2);
    expect(bySid[SID.waiting]?.account).toBe(3);
    expect(bySid[SID.private]?.account).toBe(4);
    expect(bySid[SID.busy]?.configDir).toBe(env.home.paths.claudeHome);
    expect(bySid[SID.idle]?.configDir).toBe(env.home.configDirFor(2));
    for (const r of recs) {
      const fake = env.home.session(r.sid);
      expect(r.file).toBe(fake.file);
      expect(r.cwd).toBe(fake.cwd);
      expect(r.pid).toBe(fake.pid);
      expect(r.procStart).toBe(fake.procStart);
      expect(r.entrypoint).toBe('cli');
    }
  });

  it('maps config dirs to accounts (profiles by dir name, ~/.claude to the active account)', async () => {
    const src = createClaudeFilesSource(env.ctx, SLOW);
    await src.scan();
    expect(src.accountForConfigDir(env.home.configDirFor(2))).toBe(2);
    expect(src.accountForConfigDir(`${env.home.configDirFor(3)}/`)).toBe(3);
    expect(src.accountForConfigDir(env.home.paths.claudeHome)).toBe(1);
    expect(src.accountForConfigDir(join(env.home.paths.cswapProfiles, '9-nobody_example.com'))).toBeNull();
    expect(src.accountForConfigDir('/somewhere/else')).toBeNull();
    expect(src.accountForConfigDir('')).toBeNull();
  });

  it('runs ps once per scan, with LC_ALL=C and TZ=UTC, and reuses start times for a minute', async () => {
    const src = createClaudeFilesSource(env.ctx, SLOW);
    await src.scan();
    let calls = await env.home.calls('ps');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.env.LC_ALL).toBe('C');
    expect(calls[0]?.env.TZ).toBe('UTC');
    expect(calls[0]?.args.slice(0, 3)).toEqual(['-o', 'pid=,tty=,lstart=', '-p']);
    await src.scan();
    expect(await env.home.calls('ps')).toHaveLength(1); // cached
    env.ctx.clock.advance(61_000);
    await src.scan();
    calls = await env.home.calls('ps');
    expect(calls).toHaveLength(2);
  });

  it('does not depend on the daemon time zone (ps runs in UTC, procStart is UTC)', async () => {
    const tz = process.env.TZ;
    try {
      process.env.TZ = 'Asia/Kolkata';
      const recs = await createClaudeFilesSource({ ...env.ctx, env: { ...env.ctx.env, TZ: 'America/New_York' } }, SLOW).scan();
      expect(recs.map((r) => r.sid)).toEqual([...DEFAULT_LIVE_SIDS].sort());
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });

  it('keeps sessions when ps cannot run (kill(0) alone decides)', async () => {
    const src = createClaudeFilesSource({ ...env.ctx, bins: { ...env.ctx.bins, ps: join(env.home.root, 'no-such-ps') } }, SLOW);
    const recs = await src.scan();
    // the reused pid can't be told apart without ps, so it stays; dead and sdk-cli still go
    expect(recs.map((r) => r.sid)).toEqual([...DEFAULT_LIVE_SIDS, SID.reused].sort());
    expect(env.ctx.log.records.some((r) => r.level === 'warn' && r.msg.startsWith('ps failed'))).toBe(true);
  });

  it('never opens key files, cswap configs or credentials', async () => {
    const seen: string[] = [];
    for (const m of ['readText', 'readFile', 'open'] as const) {
      const orig = fsx[m].bind(fsx) as (p: string) => Promise<unknown>;
      vi.spyOn(fsx, m).mockImplementation(((p: string) => {
        seen.push(p);
        return orig(p);
      }) as never);
    }
    const src = createClaudeFilesSource(env.ctx, SLOW);
    await src.start();
    await src.stop();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((p) => p.endsWith('.key') || p.includes('/configs/') || p.includes('/credentials/'))).toEqual([]);
    expect(JSON.stringify(env.ctx.store.getState())).not.toContain(SECRET_MARKER);
  });

  it('keeps the last good copy of a session file caught mid-write, and reads it again soon', async () => {
    const src = createClaudeFilesSource(env.ctx, SLOW);
    await src.start();
    const timers = env.ctx.clock.pending(); // the (slow) poll
    const file = env.home.session(SID.idle).file;
    const good = await env.home.readSessionFile(SID.idle);
    await writeFile(file, '{"pid": 41002, "sessionId": "2222');
    await src.scan();
    expect(src.current().map((r) => r.sid)).toContain(SID.idle);
    expect(env.events.of('session.removed')).toEqual([]);
    expect(env.ctx.clock.pending()).toBe(timers + 1); // one quick retry, not the next poll
    await writeFile(file, JSON.stringify({ ...good, name: 'finished writing' }));
    await env.ctx.clock.tick(250);
    await src.scan(); // waits for the retry's scan to finish
    expect(env.ctx.store.getState().sessions[SID.idle]?.name).toBe('finished writing');
    // a file that stays broken is retried once per new content, not in a loop
    await writeFile(file, 'garbage');
    await src.scan();
    await env.ctx.clock.tick(250);
    await src.scan();
    expect(env.ctx.clock.pending()).toBe(timers);
    await src.stop();
  });

  it('works through the factory typed for the integration step', async () => {
    const src = createSessionSource(env.ctx, {});
    expect((await src.scan()).length).toBe(DEFAULT_LIVE_SIDS.length);
  });
});

describe('claude-files: events', () => {
  let env: SourceEnv;
  beforeEach(async () => {
    env = await sourceEnv();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it('emits session.added with mapped status, account, tty and folder', async () => {
    const src = createClaudeFilesSource(env.ctx, SLOW);
    await src.start();
    const added = env.events.of('session.added');
    expect(added.map((e) => e.sid).sort()).toEqual([...DEFAULT_LIVE_SIDS].sort());
    const state = env.ctx.store.getState().sessions;
    expect(state[SID.busy]).toMatchObject({ status: 'working', statusSource: 'session-file', account: 1, folder: 'alpha-app', tty: 'ttys001' });
    expect(state[SID.idle]).toMatchObject({ status: 'idle', account: 2, folder: 'bravo-api', name: 'fix flaky tests' });
    expect(state[SID.waiting]).toMatchObject({ status: 'waiting', waitingFor: 'permission', account: 3 });
    // statusSince comes from Claude's statusUpdatedAt (2 minutes before "now")
    expect(state[SID.busy]?.statusSince).toBe(new Date(env.home.now - 120_000).toISOString());
    expect(added.find((e) => e.sid === SID.idle)?.account).toBe(2);
    await src.stop();
  });

  it('emits session.updated when Claude rewrites the file, and nothing when nothing changed', async () => {
    const src = createClaudeFilesSource(env.ctx, SLOW);
    await src.start();
    env.events.clear();
    await src.scan();
    expect(env.events.all).toEqual([]);
    env.ctx.clock.advance(5000);
    await env.home.updateSessionFile(SID.busy, { status: 'idle', statusUpdatedAt: env.ctx.clock.now() });
    await src.scan();
    const upd = env.events.of('session.updated', SID.busy);
    expect(upd).toHaveLength(1);
    expect(upd[0]?.data.patch).toMatchObject({ status: 'idle', statusSource: 'session-file' });
    expect(env.ctx.store.getState().sessions[SID.busy]?.status).toBe('idle');
    await src.stop();
  });

  it('lets a newer hook status win over an older session file', async () => {
    const src = createClaudeFilesSource(env.ctx, SLOW);
    await src.start();
    env.ctx.store.emit({
      type: 'session.updated',
      sid: SID.idle,
      data: { patch: { status: 'working', statusSource: 'hook', statusSince: env.ctx.clock.iso(), statusAt: env.ctx.clock.iso() } },
    });
    // the file changes, but its statusUpdatedAt is older than the hook observation
    await env.home.updateSessionFile(SID.idle, { status: 'idle', name: 'renamed', statusUpdatedAt: env.home.now - 60_000 });
    await src.scan();
    expect(env.ctx.store.getState().sessions[SID.idle]).toMatchObject({ status: 'working', statusSource: 'hook', name: 'renamed' });
    await src.stop();
  });

  it('removes sessions with the reason: clean exit, crash, pid reuse', async () => {
    const src = createClaudeFilesSource(env.ctx, SLOW);
    await src.start();
    await env.home.removeSessionFile(SID.busy);
    await env.home.killSession(SID.idle);
    await env.home.setProcesses(
      env.home.processes().map((p) => (p.pid === env.home.session(SID.private).pid ? { ...p, startMs: env.home.now - 1000 } : p)),
    );
    env.ctx.clock.advance(61_000); // past the ps cache
    await src.scan();
    const reasons = Object.fromEntries(env.events.of('session.removed').map((e) => [e.sid, e.data.reason]));
    expect(reasons).toEqual({ [SID.busy]: 'file-removed', [SID.idle]: 'pid-gone', [SID.private]: 'pid-reused' });
    expect(Object.keys(env.ctx.store.getState().sessions)).toEqual([SID.waiting]);
    await src.stop();
  });

  it('fixes the account of a default-login session when first seen (a later cswap switch does not relabel it)', async () => {
    const src = createClaudeFilesSource(env.ctx, SLOW);
    await src.start();
    expect(env.ctx.store.getState().sessions[SID.busy]?.account).toBe(1);
    await writeFile(env.home.paths.sequenceJson, JSON.stringify(sequenceJson(defaultAccounts(), env.home.now, 2)));
    await env.home.addSession({ sid: '88888888-8888-4888-8888-888888888888', pid: 41008, account: 1, project: 'echo-app', status: 'idle' });
    await src.scan();
    const s = env.ctx.store.getState().sessions;
    expect(s[SID.busy]?.account).toBe(1);
    expect(s['88888888-8888-4888-8888-888888888888']?.account).toBe(2);
    expect(src.accountForConfigDir(env.home.paths.claudeHome)).toBe(2);
    await src.stop();

    // the pin survives a daemon restart (it lives in the db's kv store)
    const again = createClaudeFilesSource(env.ctx, SLOW);
    const recs = await again.scan();
    expect(recs.find((r) => r.sid === SID.busy)?.account).toBe(1);
  });

  it('follows a session that moved to another profile (same sid, new pid)', async () => {
    const src = createClaudeFilesSource(env.ctx, SLOW);
    await src.start();
    await env.home.removeSessionFile(SID.idle);
    await env.home.addSession({ sid: SID.idle, pid: 41020, account: 4, project: 'bravo-api', status: 'busy', tty: 'ttys020' });
    await src.scan();
    const upd = env.events.of('session.updated', SID.idle).at(-1);
    expect(upd?.data.patch).toMatchObject({ pid: 41020, account: 4, configDir: env.home.configDirFor(4), status: 'working', tty: 'ttys020' });
    expect(env.events.of('session.removed', SID.idle)).toEqual([]);
    await src.stop();
  });

  it('a session ended by its old process is live again once the same sid shows up in a new process', async () => {
    const src = createClaudeFilesSource(env.ctx, SLOW);
    await src.start();
    // The old process's SessionEnd hook (through the hooks bridge).
    env.ctx.clock.advance(1000);
    const endedAt = env.ctx.clock.iso();
    env.ctx.store.emit({ type: 'session.updated', sid: SID.idle, data: { patch: { status: 'ended', statusSource: 'hook', statusSince: endedAt, statusAt: endedAt } } });
    // ccw moves it: the old file goes and the resumed process writes its own, within one scan.
    await env.home.removeSessionFile(SID.idle);
    const moved = await env.home.addSession({ sid: SID.idle, pid: 41020, account: 4, project: 'bravo-api', status: 'busy', tty: 'ttys020' });
    env.ctx.clock.advance(1000);
    const file = JSON.parse(await readFile(moved.file, 'utf8')) as Record<string, unknown>;
    await writeFile(moved.file, JSON.stringify({ ...file, statusUpdatedAt: env.ctx.clock.now() }));
    await src.scan();
    expect(env.ctx.store.getState().sessions[SID.idle]).toMatchObject({ pid: 41020, account: 4, status: 'working', statusSource: 'session-file' });
    expect(env.events.of('session.removed', SID.idle)).toEqual([]);
    await src.stop();
  });

  it('emits session.waiting after a short settle when the session file says waiting', async () => {
    const src = createClaudeFilesSource(env.ctx, SLOW);
    await src.start();
    env.ctx.clock.advance(1000);
    await env.home.updateSessionFile(SID.idle, { status: 'waiting', waitingFor: 'question', statusUpdatedAt: env.ctx.clock.now() });
    await src.scan();
    expect(env.events.of('session.waiting')).toEqual([]);
    env.ctx.clock.advance(1500);
    const w = env.events.of('session.waiting', SID.idle);
    expect(w).toHaveLength(1);
    expect(w[0]?.data).toEqual({ waitingFor: 'question' });
    await src.stop();
  });

  it('stays quiet when a hook card arrives within the settle time', async () => {
    const src = createClaudeFilesSource(env.ctx, SLOW);
    await src.start();
    env.ctx.clock.advance(1000);
    await env.home.updateSessionFile(SID.idle, { status: 'waiting', waitingFor: 'permission', statusUpdatedAt: env.ctx.clock.now() });
    await src.scan();
    env.ctx.store.emit({
      type: 'pending.opened',
      sid: SID.idle,
      data: { pending: makePending({ sid: SID.idle, createdAt: env.ctx.clock.iso(), settleUntil: env.ctx.clock.iso(env.ctx.clock.now() + 3000) }) },
    });
    env.ctx.clock.advance(2000);
    expect(env.events.of('session.waiting')).toEqual([]);
    await src.stop();
  });

  it('stop() clears every timer', async () => {
    const src = createClaudeFilesSource(env.ctx, { watch: false });
    await src.start();
    await env.home.updateSessionFile(SID.idle, { status: 'waiting', statusUpdatedAt: env.ctx.clock.now() + 1 });
    await src.scan();
    expect(env.ctx.clock.pending()).toBeGreaterThan(0);
    await src.stop();
    expect(env.ctx.clock.pending()).toBe(0);
  });
});

describe('claude-files: FS watch', () => {
  let env: SourceEnv;
  beforeEach(async () => {
    env = await sourceEnv();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it('picks up a new session file from an FS event, without waiting for the poll', async () => {
    const ctx = withRealClock(env.ctx);
    const events = record(ctx);
    const src = createClaudeFilesSource(ctx, { watch: true, pollMs: 600_000, debounceMs: 20 });
    await src.start();
    // libuv arms FSEvents on another thread: an event in the first moments can be missed (the
    // daemon's 2 s poll covers that; this test has the poll turned off)
    await new Promise((r) => setTimeout(r, 500));
    const sid = '99999999-9999-4999-8999-999999999999';
    await env.home.addSession({ sid, pid: 41009, account: 3, project: 'foxtrot', status: 'idle' });
    // the fixture marks the pid alive only after writing the file; real Claude is alive first, so
    // rewrite the file once more (as Claude does) to get an FS event after the pid is up
    await env.home.updateSessionFile(sid, { updatedAt: env.home.now });
    await vi.waitFor(() => expect(events.of('session.added', sid)).toHaveLength(1), { timeout: 8000, interval: 50 });
    expect(ctx.store.getState().sessions[sid]?.account).toBe(3);
    await src.stop();
    events.stop();
  });
});
