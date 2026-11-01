import { EventEmitter } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { legacyStateDirRefusal, resolvePaths } from '../src/config.js';
import type { DaemonOptions, RunningDaemon } from '../src/daemon.js';
import { memoryLogger } from '../src/core/log.js';
import { EXIT, main, parseDaemonArgs, type MainProcess } from '../src/main.js';

function fakeProc(env: Record<string, string | undefined> = { HOME: '/nonexistent-home' }): MainProcess & EventEmitter {
  const ee = new EventEmitter() as EventEmitter & MainProcess;
  Object.assign(ee, { env, pid: 4242 });
  return ee;
}

function fakeDaemon(stop: () => Promise<void> = async () => {}): RunningDaemon & { stops: number } {
  const d = {
    stops: 0,
    ctx: { log: memoryLogger() },
    parts: {},
    mode: { readOnly: false, terminal: 'terminal-app' },
    address: () => ({ host: '127.0.0.1', port: 7420 }),
    stop: async () => {
      d.stops += 1;
      await stop();
    },
  };
  return d as unknown as RunningDaemon & { stops: number };
}

const io = () => {
  const o = { out: '', err: '' };
  return { o, stdout: (s: string) => (o.out += s), stderr: (s: string) => (o.err += s) };
};

describe('parseDaemonArgs', () => {
  it('parses every flag, in both --flag value and --flag=value forms', () => {
    expect(parseDaemonArgs([])).toEqual({ ok: true, flags: { noTerminal: false, readOnly: false, logFiles: false, help: false, version: false } });
    expect(parseDaemonArgs(['--port', '7491', '--home', '/tmp/x', '--no-terminal', '--read-only'])).toEqual({
      ok: true,
      flags: { port: 7491, home: '/tmp/x', noTerminal: true, readOnly: true, logFiles: false, help: false, version: false },
    });
    // v0.6: the daemon writes its own log files.
    expect(parseDaemonArgs(['--log-files'])).toMatchObject({ ok: true, flags: { logFiles: true } });
    expect(parseDaemonArgs(['--log-files=1']).ok).toBe(false);
    expect(parseDaemonArgs(['--port=0', '--home=/a b'])).toMatchObject({ ok: true, flags: { port: 0, home: '/a b' } });
    expect(parseDaemonArgs(['-h'])).toMatchObject({ ok: true, flags: { help: true } });
    expect(parseDaemonArgs(['-v'])).toMatchObject({ ok: true, flags: { version: true } });
  });

  it('rejects bad values and unknown flags', () => {
    for (const argv of [['--port'], ['--port', 'abc'], ['--port', '70000'], ['--port', '-1'], ['--port', '--read-only'], ['--home'], ['--home='], ['--read-only=yes'], ['--no-terminal=1'], ['--frobnicate'], ['serve']]) {
      expect(parseDaemonArgs(argv).ok, argv.join(' ')).toBe(false);
    }
  });
});

describe('main', () => {
  it('prints the version and help without starting anything', async () => {
    let started = 0;
    const start = async () => {
      started += 1;
      return fakeDaemon();
    };
    const a = io();
    expect(await main(['--version'], { ...a, start, proc: fakeProc() })).toBe(EXIT.ok);
    expect(a.o.out).toMatch(/^jantard \d+\.\d+\.\d+\n$/);
    const b = io();
    expect(await main(['--help'], { ...b, start, proc: fakeProc() })).toBe(EXIT.ok);
    expect(b.o.out).toContain('--read-only');
    expect(started).toBe(0);
  });

  it('exits 2 on a bad flag or a state dir too deep for Unix sockets', async () => {
    const a = io();
    expect(await main(['--nope'], { ...a, proc: fakeProc() })).toBe(EXIT.usage);
    expect(a.o.err).toContain('unknown option: --nope');
    const b = io();
    const deep = `/tmp/${'d'.repeat(120)}`;
    expect(await main(['--home', deep], { ...b, proc: fakeProc() })).toBe(EXIT.usage);
    expect(b.o.err).toContain('too deep');
  });

  it('passes the flags to the daemon and stops it on SIGTERM', async () => {
    const proc = fakeProc({ HOME: '/nonexistent-home', JANTAR_HOME: '/elsewhere' });
    const d = fakeDaemon();
    let got: DaemonOptions | undefined;
    const run = main(['--port', '7491', '--home', '/tmp/jantar-x', '--no-terminal', '--read-only'], {
      ...io(),
      proc,
      start: async (opts) => {
        got = opts;
        return d;
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(got).toMatchObject({ port: 7491, readOnly: true, terminal: false });
    expect(got?.env?.JANTAR_HOME).toBe('/tmp/jantar-x');
    expect(proc.listenerCount('SIGTERM')).toBe(1);
    proc.emit('SIGTERM');
    expect(await run).toBe(EXIT.ok);
    expect(d.stops).toBe(1);
    expect(proc.listenerCount('SIGTERM')).toBe(0);
    expect(proc.listenerCount('SIGINT')).toBe(0);
  });

  it('logs one deprecation warning when only the old CCW_V2_HOME names the state dir', async () => {
    const proc = fakeProc({ HOME: '/nonexistent-home', CCW_V2_HOME: '/tmp/jantar-old' });
    const d = fakeDaemon();
    let got: DaemonOptions | undefined;
    const run = main([], {
      ...io(),
      proc,
      start: async (opts) => {
        got = opts;
        return d;
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(got?.env?.CCW_V2_HOME).toBe('/tmp/jantar-old');
    const log = d.ctx.log as ReturnType<typeof memoryLogger>;
    expect(log.records.filter((r) => r.level === 'warn').map((r) => r.msg)).toEqual([
      'CCW_V2_HOME is deprecated: set JANTAR_HOME instead (using /tmp/jantar-old for now).',
    ]);
    proc.emit('SIGTERM');
    expect(await run).toBe(EXIT.ok);
  });

  it('refuses a ccw-v2 state dir (CCW_V2_HOME naming it) before anything starts, and leaves it byte for byte', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jantar-old-'));
    try {
      writeFileSync(join(dir, 'ccw-v2.db'), 'synthetic old database');
      writeFileSync(join(dir, 'config.json'), '{"version":1}\n');
      const before = readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), 'utf8')]);
      const o = io();
      let started = false;
      const code = await main([], {
        stdout: o.stdout,
        stderr: o.stderr,
        proc: fakeProc({ HOME: '/nonexistent-home', CCW_V2_HOME: dir }),
        start: async () => {
          started = true;
          return fakeDaemon();
        },
      });
      expect(code).toBe(EXIT.usage);
      expect(started).toBe(false);
      expect(o.o.err).toBe(`jantard: ${dir} is a ccw-v2 state dir. Set JANTAR_HOME to a new folder and run: jantar import-ccw-v2 --from ${dir}\n`);
      expect(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), 'utf8')])).toEqual(before);
      // Once it holds Jantar's own database (an import's target, say), it is Jantar's.
      writeFileSync(join(dir, 'jantar.db'), '');
      expect(legacyStateDirRefusal(resolvePaths({ env: { HOME: '/nonexistent-home', CCW_V2_HOME: dir } }))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the terminal on by default and honours SIGINT', async () => {
    const proc = fakeProc();
    const d = fakeDaemon();
    let got: DaemonOptions | undefined;
    const run = main([], {
      ...io(),
      proc,
      start: async (opts) => {
        got = opts;
        return d;
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(got?.terminal).toBeUndefined();
    expect(got?.readOnly).toBe(false);
    expect(got?.port).toBeUndefined();
    proc.emit('SIGINT');
    expect(await run).toBe(EXIT.ok);
  });

  it('stops right after startup when a signal arrived while starting', async () => {
    const proc = fakeProc();
    const d = fakeDaemon();
    const run = main([], {
      ...io(),
      proc,
      start: async () => {
        proc.emit('SIGTERM');
        return d;
      },
    });
    expect(await run).toBe(EXIT.ok);
    expect(d.stops).toBe(1);
  });

  it('exits 1 when startup fails, and detaches its signal handlers', async () => {
    const proc = fakeProc();
    const a = io();
    const code = await main([], {
      ...a,
      proc,
      start: async () => {
        throw new Error('port 7420 is in use');
      },
    });
    expect(code).toBe(EXIT.failed);
    expect(a.o.err).toContain('could not start: port 7420 is in use');
    expect(proc.listenerCount('SIGTERM')).toBe(0);
  });

  it('gives up on a stop that hangs, and on a second signal', async () => {
    const proc = fakeProc();
    const hang = fakeDaemon(() => new Promise(() => {}));
    const run = main([], { ...io(), proc, start: async () => hang, stopTimeoutMs: 50 });
    await new Promise((r) => setTimeout(r, 10));
    proc.emit('SIGTERM');
    expect(await run).toBe(EXIT.failed);

    const proc2 = fakeProc();
    const hang2 = fakeDaemon(() => new Promise(() => {}));
    const run2 = main([], { ...io(), proc: proc2, start: async () => hang2, stopTimeoutMs: 60_000 });
    await new Promise((r) => setTimeout(r, 10));
    proc2.emit('SIGTERM');
    proc2.emit('SIGTERM');
    expect(await run2).toBe(EXIT.failed);
    expect(hang2.stops).toBe(1);
  });
});
