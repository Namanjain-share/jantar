import { describe, expect, it } from 'vitest';
import type { DaemonEvent } from '@jantar/protocol';
import type { Service } from '../src/contracts.js';
import {
  CSWAP_SCRUB_ENV,
  FakeClock,
  actorId,
  canonicalJson,
  cLocale,
  correlationKey,
  createExecFile,
  createLogger,
  createMemoryDb,
  mapRawStatus,
  memoryLogger,
  mergeStatus,
  newId,
  newSecretId,
  randomToken,
  realProcessProbe,
  safeEqual,
  scrubEnv,
  sha256Hex,
  type StatusFields,
} from '../src/core/index.js';
import { createFakeExec, createTestContext, fixedProbe, onCommand } from '../src/core/testing.js';
import { startServices } from '../src/lifecycle.js';

const T = (s: number) => Date.parse('2026-01-15T10:00:00.000Z') + s * 1000;
const iso = (s: number) => new Date(T(s)).toISOString();

describe('FakeClock', () => {
  it('runs timers in time order only when advanced', async () => {
    const c = new FakeClock('2026-01-15T10:00:00.000Z');
    const order: string[] = [];
    c.setTimeout(() => order.push('b'), 200);
    c.setTimeout(() => order.push('a'), 100);
    const iv = c.setInterval(() => order.push('i'), 150);
    const cancelled = c.setTimeout(() => order.push('x'), 50);
    c.clearTimeout(cancelled);
    c.advance(99);
    expect(order).toEqual([]);
    c.advance(251);
    expect(order).toEqual(['a', 'i', 'b', 'i']);
    c.clearInterval(iv);
    c.advance(1000);
    expect(order).toHaveLength(4);
    expect(c.now()).toBe(T(1.35));
    expect(c.iso()).toBe('2026-01-15T10:00:01.350Z');

    const slept = c.sleep(500).then(() => 'woke');
    await c.tick(500);
    await expect(slept).resolves.toBe('woke');

    const ac = new AbortController();
    const aborted = c.sleep(500, ac.signal);
    ac.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    expect(c.pending()).toBe(0);
  });
});

describe('hashing and ids', () => {
  it('canonical JSON sorts keys at every level', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[3,{"y":2,"z":1}]},"b":1}');
    expect(canonicalJson(undefined)).toBe('null');
    expect(correlationKey('s1', 'Bash', { timeout: 5, command: 'ls' })).toBe('s1|Bash|{"command":"ls","timeout":5}');
    expect(correlationKey('s1', 'Bash', { command: 'ls', timeout: 5 })).toBe(correlationKey('s1', 'Bash', { timeout: 5, command: 'ls' }));
  });

  it('hashes and compares', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });

  it('makes sortable and unguessable ids', () => {
    expect(newId()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const s = newSecretId();
    expect(s.length).toBe(26 + 16);
    expect(newSecretId()).not.toBe(s);
    expect(randomToken(16)).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('names actors for the audit log', () => {
    expect(actorId({ kind: 'device', deviceId: 'd1', scopes: ['read'] })).toBe('device:d1');
    expect(actorId({ kind: 'cli' })).toBe('cli');
    expect(actorId({ kind: 'system' })).toBe('system');
  });
});

describe('exec', () => {
  const exec = createExecFile();
  const node = process.execPath;

  it('runs with argv only and feeds stdin', async () => {
    const r = await exec(node, ['-e', 'process.stdin.pipe(process.stdout); console.error(process.argv[1])', '$(not a shell) "quoted"'], {
      input: 'from stdin',
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('from stdin');
    expect(r.stderr.trim()).toBe('$(not a shell) "quoted"');
    expect(r.timedOut).toBe(false);
  });

  it('reports exit codes, timeouts, missing binaries and truncation without throwing', async () => {
    expect((await exec(node, ['-e', 'process.exit(3)'])).code).toBe(3);
    const slow = await exec(node, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 200 });
    expect(slow.timedOut).toBe(true);
    expect(slow.code).toBeNull();
    const missing = await exec('/nonexistent/definitely-not-here', []);
    expect(missing.spawnError).toMatch(/ENOENT/);
    const big = await exec(node, ['-e', 'process.stdout.write("x".repeat(5000))'], { maxBuffer: 1000 });
    expect(big.truncated).toBe(true);
    expect(big.stdout.length).toBe(1000);
  });

  it('passes exactly the given environment', async () => {
    const r = await exec(node, ['-e', 'console.log(JSON.stringify([process.env.A, process.env.CLAUDE_CONFIG_DIR]))'], {
      env: scrubEnv({ A: '1', CLAUDE_CONFIG_DIR: '/x', PATH: process.env.PATH }, CSWAP_SCRUB_ENV),
    });
    expect(JSON.parse(r.stdout)).toEqual(['1', null]);
    expect(cLocale({ A: '1' })).toEqual({ A: '1', LC_ALL: 'C', LANG: 'C' });
  });

  it('fakes exec for tests', async () => {
    const fake = createFakeExec(onCommand('cswap', { stdout: '{"ok":true}' }, ['list']));
    expect((await fake('/fake/bin/cswap', ['list', '--json'])).stdout).toBe('{"ok":true}');
    expect((await fake('/fake/bin/cswap', ['switch'])).code).toBe(127);
    fake.handle(onCommand('/fake/bin/ps', (call) => ({ stdout: call.args.join(' ') })));
    expect((await fake('/fake/bin/ps', ['-o', 'tty='])).stdout).toBe('-o tty=');
    expect(fake.calls.map((c) => c.args[0])).toEqual(['list', 'switch', '-o']);
  });
});

describe('process probe', () => {
  it('sees this process and not a bogus pid', () => {
    expect(realProcessProbe.isAlive(process.pid)).toBe(true);
    expect(realProcessProbe.isAlive(0)).toBe(false);
    expect(realProcessProbe.isAlive(-5)).toBe(false);
    expect(fixedProbe([7]).isAlive(7)).toBe(true);
    expect(fixedProbe([7]).isAlive(8)).toBe(false);
  });
});

describe('logger', () => {
  it('writes JSON lines and redacts secret-looking fields', () => {
    const lines: string[] = [];
    const log = createLogger({ write: (l) => lines.push(l), level: 'info', now: () => T(0) });
    log.debug('hidden');
    log.info('sent', { sid: 's1', text: 'my prompt', token: 'abc' });
    log.child({ part: 'writer' }).warn('slow', { ms: 5 });
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0] as string);
    expect(first).toMatchObject({ level: 'info', msg: 'sent', sid: 's1', text: '[redacted]', token: '[redacted]' });
    expect(JSON.parse(lines[1] as string)).toMatchObject({ part: 'writer', ms: 5 });
    const mem = memoryLogger();
    mem.child({ a: 1 }).error('x', { b: 2 });
    expect(mem.records).toEqual([{ level: 'error', msg: 'x', fields: { a: 1, b: 2 } }]);
  });
});

describe('status precedence', () => {
  const base: StatusFields = { status: 'working', statusSource: 'session-file', statusSince: iso(0), statusAt: iso(0) };

  it('maps Claude session-file words', () => {
    expect(mapRawStatus('busy')).toBe('working');
    expect(mapRawStatus('idle')).toBe('idle');
    expect(mapRawStatus('waiting')).toBe('waiting');
    expect(mapRawStatus(undefined)).toBe('idle');
  });

  it('accepts a newer observation from any non-transcript source', () => {
    const r = mergeStatus(base, { status: 'idle', source: 'hook', at: T(5) });
    expect(r).toEqual({ patch: { status: 'idle', statusSource: 'hook', statusSince: iso(5), statusAt: iso(5) }, unset: [] });
  });

  it('drops stale observations (out-of-order hooks, older session file)', () => {
    const hookIdle: StatusFields = { status: 'idle', statusSource: 'hook', statusSince: iso(10), statusAt: iso(10) };
    expect(mergeStatus(hookIdle, { status: 'working', source: 'session-file', at: T(9) })).toBeNull();
    expect(mergeStatus(hookIdle, { status: 'working', source: 'hook', at: T(9.5) })).toBeNull();
    // a newer session file wins over an older hook state
    expect(mergeStatus(hookIdle, { status: 'working', source: 'session-file', at: T(11) })?.patch.status).toBe('working');
  });

  it('breaks ties by source rank', () => {
    const fileIdle: StatusFields = { status: 'idle', statusSource: 'session-file', statusSince: iso(10), statusAt: iso(10) };
    expect(mergeStatus(fileIdle, { status: 'working', source: 'hook', at: T(10) })?.patch.status).toBe('working');
    const hookIdle: StatusFields = { ...fileIdle, statusSource: 'hook' };
    expect(mergeStatus(hookIdle, { status: 'working', source: 'session-file', at: T(10) })).toBeNull();
  });

  it('never lets transcript heuristics override hooks or the session file', () => {
    expect(mergeStatus(base, { status: 'idle', source: 'transcript', at: T(100) })).toBeNull();
    const fromTranscript: StatusFields = { ...base, statusSource: 'transcript' };
    expect(mergeStatus(fromTranscript, { status: 'idle', source: 'transcript', at: T(100) })?.patch.status).toBe('idle');
  });

  it('records confirmations without changing statusSince', () => {
    const r = mergeStatus(base, { status: 'working', source: 'hook', at: T(3) });
    expect(r).toEqual({ patch: { statusAt: iso(3), statusSource: 'hook' }, unset: [] });
    expect(mergeStatus(base, { status: 'working', source: 'session-file', at: T(0) })).toBeNull();
    // the confirmation makes a late, older hook stale
    const confirmed: StatusFields = { ...base, statusSource: 'hook', statusAt: iso(3) };
    expect(mergeStatus(confirmed, { status: 'idle', source: 'hook', at: T(2) })).toBeNull();
  });

  it('handles waitingFor and ended', () => {
    const w = mergeStatus(base, { status: 'waiting', source: 'session-file', at: T(1), waitingFor: 'permission' });
    expect(w?.patch).toMatchObject({ status: 'waiting', waitingFor: 'permission' });
    const waiting: StatusFields = { status: 'waiting', statusSource: 'session-file', statusSince: iso(1), statusAt: iso(1), waitingFor: 'permission' };
    expect(mergeStatus(waiting, { status: 'working', source: 'hook', at: T(2) })?.unset).toEqual(['waitingFor']);
    // ended wins even when older, and neither hooks nor transcripts revive an ended session...
    expect(mergeStatus(waiting, { status: 'ended', source: 'transcript', at: T(0) })?.patch.status).toBe('ended');
    expect(mergeStatus({ ...waiting, status: 'ended' }, { status: 'working', source: 'hook', at: T(99) })).toBeNull();
    // ...but a session file written after the end does: a live process owns the sid again (resumed elsewhere).
    const ended: StatusFields = { status: 'ended', statusSource: 'hook', statusSince: iso(5), statusAt: iso(5) };
    expect(mergeStatus(ended, { status: 'working', source: 'session-file', at: T(6) })).toEqual({
      patch: { status: 'working', statusSource: 'session-file', statusSince: iso(6), statusAt: iso(6) },
      unset: [],
    });
    expect(mergeStatus(ended, { status: 'idle', source: 'session-file', at: T(5) })).toBeNull();
    expect(mergeStatus(ended, { status: 'idle', source: 'session-file', at: T(4) })).toBeNull();
    expect(mergeStatus(ended, { status: 'idle', source: 'transcript', at: T(9) })).toBeNull();
    // no current session: initial fields
    expect(mergeStatus(undefined, { status: 'idle', source: 'session-file', at: T(0) })?.patch).toEqual({
      status: 'idle',
      statusSource: 'session-file',
      statusSince: iso(0),
      statusAt: iso(0),
    });
  });
});

describe('memory db', () => {
  it('stores events, audit, devices, push subs, pending history and kv', () => {
    const db = createMemoryDb();
    const ev = (seq: number, type: 'session.removed' | 'alert.error'): DaemonEvent =>
      type === 'alert.error'
        ? { seq, ts: iso(seq), type, data: { alert: { id: `a${seq}`, ts: iso(seq), kind: 'error', label: 'l', what: 'w' } } }
        : { seq, ts: iso(seq), type, sid: 's', data: {} };
    for (let i = 1; i <= 5; i++) db.events.append(ev(i, i % 2 ? 'session.removed' : 'alert.error'));
    expect(db.events.maxSeq()).toBe(5);
    expect(db.events.since(3).map((e) => e.seq)).toEqual([4, 5]);
    expect(db.events.latest({ limit: 2, types: ['alert.error'] }).map((e) => e.seq)).toEqual([4, 2]);
    expect(db.events.prune(2)).toBe(3);
    expect(db.events.since(0).map((e) => e.seq)).toEqual([4, 5]);

    const a1 = db.audit.append({ ts: iso(0), actor: 'cli', action: 'send', params: {}, result: 'ok' });
    db.audit.append({ ts: iso(1), actor: 'cli', action: 'focus', params: {}, result: 'refused' });
    expect(a1.seq).toBe(1);
    expect(db.audit.list({ after: 1 }).map((a) => a.action)).toEqual(['focus']);
    expect(db.audit.list({ limit: 1 }).map((a) => a.action)).toEqual(['focus']);

    db.devices.insert({ id: 'd1', name: 'phone', keyHash: 'h1', scopes: ['read'], createdAt: iso(0), lastSeenAt: iso(0) });
    expect(() => db.devices.insert({ id: 'd1', name: 'x', keyHash: 'h2', scopes: ['read'], createdAt: iso(0), lastSeenAt: iso(0) })).toThrow();
    db.devices.touch('d1', iso(9));
    expect(db.devices.byKeyHash('h1')?.lastSeenAt).toBe(iso(9));
    expect(db.devices.revoke('d1', iso(10))?.revokedAt).toBe(iso(10));
    expect(db.devices.revoke('nope', iso(10))).toBeNull();

    const sub = { endpoint: 'https://push.example.com/abc', keys: { p256dh: 'p', auth: 'a' } };
    db.pushSubs.upsert({ subscription: sub, deviceId: 'd1', createdAt: iso(0) });
    db.pushSubs.upsert({ subscription: sub, deviceId: 'd1', createdAt: iso(1) });
    expect(db.pushSubs.list()).toHaveLength(1);
    expect(db.pushSubs.removeForDevice('d1')).toBe(1);

    db.kv.set('told:s1', { at: 1 });
    expect(db.kv.get('told:s1')).toEqual({ at: 1 });
    db.kv.delete('told:s1');
    expect(db.kv.get('told:s1')).toBeUndefined();
    db.close();
    expect(db.closed).toBe(true);
  });
});

describe('lifecycle', () => {
  it('starts in order, stops in reverse, and rolls back on a failed start', async () => {
    const log = memoryLogger();
    const order: string[] = [];
    const svc = (name: string, failStart = false): Service => ({
      start: async () => {
        if (failStart) throw new Error(`${name} failed`);
        order.push(`start:${name}`);
      },
      stop: async () => {
        order.push(`stop:${name}`);
      },
    });
    const stop = await startServices([['a', svc('a')], ['b', svc('b')]], log);
    await stop();
    expect(order).toEqual(['start:a', 'start:b', 'stop:b', 'stop:a']);

    order.length = 0;
    await expect(startServices([['a', svc('a')], ['b', svc('b', true)], ['c', svc('c')]], log)).rejects.toThrow('b failed');
    expect(order).toEqual(['start:a', 'stop:a']);
  });
});

describe('createTestContext', () => {
  it('builds a context with fakes only', () => {
    const ctx = createTestContext({ userHome: '/synthetic/home' });
    expect(ctx.paths.home).toBe('/synthetic/home/.jantar');
    expect(ctx.settings.get().autoswitch.on).toBe(false);
    ctx.store.emit({ type: 'session.removed', sid: 's', data: {} });
    expect(ctx.store.seq).toBe(1);
    expect(ctx.proc.isAlive(process.pid)).toBe(false);
    expect(ctx.clock.now()).toBe(T(0));
  });
});
