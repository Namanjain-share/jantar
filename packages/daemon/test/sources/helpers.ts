/**
 * Test helpers for the data sources: a synthetic HOME (makeFakeHome) wired
 * into a DaemonContext with the real exec (so the fake `ps`, `lsof` and
 * `cswap` on the fake PATH really run), a FakeClock set to the fake home's
 * "now", and an event recorder.
 */
import { makeFakeHome, type FakeHome, type FakeHomeOptions } from '@jantar/fixtures';
import { defaultSettings, type DaemonEvent, type EventType, type Settings } from '@jantar/protocol';
import type { DaemonContext, ExecFile } from '../../src/contracts.js';
import { FakeClock, systemClock } from '../../src/core/clock.js';
import { createExecFile } from '../../src/core/exec.js';
import { createTestContext, type TestContext } from '../../src/core/testing.js';

export interface SourceEnv {
  home: FakeHome;
  ctx: TestContext;
  events: Recorder;
  cleanup(): Promise<void>;
}

export interface SourceEnvOptions {
  home?: FakeHomeOptions;
  settings?: Settings;
  exec?: ExecFile;
  /** Extra env for the daemon (e.g. CLAUDE_CONFIG_DIR to prove it is scrubbed). */
  env?: Record<string, string>;
}

export async function sourceEnv(opts: SourceEnvOptions = {}): Promise<SourceEnv> {
  const home = await makeFakeHome(opts.home);
  const ctx = createTestContext({
    userHome: home.home,
    home: home.jantarHome,
    env: { ...home.env, ...opts.env },
    proc: home.probe,
    exec: opts.exec ?? createExecFile(),
    clock: new FakeClock(home.now),
    settings: opts.settings ?? defaultSettings(),
    bins: { ps: home.bins.ps, lsof: home.bins.lsof, cswap: home.bins.cswap, osascript: home.bins.osascript },
  });
  const events = record(ctx);
  return {
    home,
    ctx,
    events,
    async cleanup() {
      events.stop();
      await home.cleanup();
    },
  };
}

/** The same context on the real clock (for FS watch tests). */
export function withRealClock(ctx: TestContext): DaemonContext {
  return { ...ctx, clock: systemClock };
}

export interface Recorder {
  all: DaemonEvent[];
  of<K extends EventType>(type: K, sid?: string): Extract<DaemonEvent, { type: K }>[];
  clear(): void;
  stop(): void;
}

export function record(ctx: DaemonContext): Recorder {
  const all: DaemonEvent[] = [];
  const stop = ctx.store.subscribe((ev) => all.push(ev));
  return {
    all,
    of(type, sid) {
      return all.filter((e) => e.type === type && (sid === undefined || e.sid === sid)) as never;
    },
    clear() {
      all.length = 0;
    },
    stop,
  };
}

/** Synthetic sids from the default fake home. */
export const SID = {
  busy: '11111111-1111-4111-8111-111111111111',
  idle: '22222222-2222-4222-8222-222222222222',
  waiting: '33333333-3333-4333-8333-333333333333',
  sdk: '44444444-4444-4444-8444-444444444444',
  reused: '55555555-5555-4555-8555-555555555555',
  crashed: '66666666-6666-4666-8666-666666666666',
  private: '77777777-7777-4777-8777-777777777777',
} as const;

/** An entry context at the clock's current time. */
export function at(ctx: DaemonContext, sid: string, cwd: string, offsetMs = 0) {
  return { sessionId: sid, cwd, at: new Date(ctx.clock.now() + offsetMs).toISOString() };
}
