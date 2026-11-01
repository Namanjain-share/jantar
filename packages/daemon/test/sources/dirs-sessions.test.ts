/**
 * v0.6 Fleet, lane L2: sessions on a paired server (sources/claude-files).
 *
 * - accountsMode "dirs": a session's account is its config dir's kept
 *   number (~/.claude is 0, ~/.claude-work 1), also after another dir is
 *   added; nothing is pinned.
 * - Linux `ps` prints `?` for a process with no terminal: no tty.
 * - Windows: `ps` is never run; liveness is kill(pid, 0) alone, no tty.
 *
 * `ps` is scripted (no fake binary): these are the shapes procps prints.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { linuxHome, windowsHome, writeHomeLayout } from '@jantar/fixtures';
import type { AccountsMode } from '@jantar/protocol';
import { FakeClock } from '../../src/core/clock.js';
import { createFakeExec, createTestContext, fixedProbe, onCommand } from '../../src/core/testing.js';
import { PINNED_KV_KEY, createClaudeFilesSource } from '../../src/sources/claude-files/index.js';
import { DIR_IDS_KV_KEY } from '../../src/sources/cswap/dirs.js';

const NOW = Date.UTC(2026, 10, 1, 10, 0, 0);
const STARTED = NOW - 60 * 60_000;
const SLOW = { watch: false, pollMs: 1e9 } as const;
const SID = {
  plain: '0a0a0a0a-0000-4000-8000-000000000001',
  work: '0a0a0a0a-0000-4000-8000-000000000002',
  ops: '0a0a0a0a-0000-4000-8000-000000000003',
} as const;

/** Claude's procStart (and procps' lstart under TZ=UTC): "Sun Nov  1 09:00:00 2026". */
function lstart(ms: number): string {
  const d = new Date(ms);
  const day = String(d.getUTCDate()).padStart(2, ' ');
  const hms = [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]} ${day} ${hms} ${d.getUTCFullYear()}`;
}

let root: string;
let home: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jantar-dirs-sessions-'));
  home = join(root, 'home', 'sam');
  await mkdir(home, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function sessionFile(configDir: string, sid: string, pid: number): Promise<void> {
  await mkdir(join(home, configDir, 'sessions'), { recursive: true });
  await writeFile(
    join(home, configDir, 'sessions', `${pid}.json`),
    JSON.stringify({ pid, sessionId: sid, cwd: '/home/sam/code/api-server', startedAt: STARTED, kind: 'interactive', entrypoint: 'cli', status: 'idle', procStart: lstart(STARTED) }),
  );
}

/** A procps row: `ps -o pid=,tty=,lstart=`. */
const psRow = (pid: number, tty: string) => `${String(pid).padStart(7, ' ')} ${tty.padEnd(8, ' ')} ${lstart(STARTED)}`;

function rig(opts: { mode?: AccountsMode; ps?: string; pids: number[] }) {
  const exec = createFakeExec(onCommand('ps', { stdout: `${opts.ps ?? ''}\n`, code: 0 }));
  const ctx = createTestContext({ userHome: home, exec, proc: fixedProbe(opts.pids), clock: new FakeClock(NOW), accountsMode: opts.mode ?? 'dirs' });
  return { ctx, exec };
}

describe('claude-files on a server whose accounts are config dirs', () => {
  it('each session is its config dir\'s number; adding a dir renumbers nothing; nothing is pinned', async () => {
    await writeHomeLayout(home, linuxHome());
    await sessionFile('.claude', SID.plain, 4101);
    await sessionFile('.claude-work', SID.work, 4102);
    const { ctx } = rig({ pids: [4101, 4102, 4103], ps: [psRow(4101, 'pts/1'), psRow(4102, 'pts/2'), psRow(4103, 'pts/3')].join('\n') });
    const src = createClaudeFilesSource(ctx, SLOW);
    await src.start();
    try {
      const st = () => ctx.store.getState().sessions;
      expect(st()[SID.plain]).toMatchObject({ account: 0, configDir: join(home, '.claude'), tty: 'pts/1' });
      expect(st()[SID.work]).toMatchObject({ account: 1, configDir: join(home, '.claude-work'), tty: 'pts/2' });
      expect(src.accountForConfigDir(join(home, '.claude-work'))).toBe(1);
      expect(src.accountForConfigDir(join(home, '.claude-scratch'))).toBeNull();

      // a new login dir that sorts first, with a session of its own
      await mkdir(join(home, '.claude-ops'), { recursive: true });
      await writeFile(join(home, '.claude-ops', '.claude.json'), '{}\n');
      await sessionFile('.claude-ops', SID.ops, 4103);
      await src.scan();
      expect(st()[SID.ops]?.account).toBe(2);
      expect(st()[SID.work]?.account).toBe(1);
      expect(ctx.db.kv.get(DIR_IDS_KV_KEY)).toEqual({ '.claude-work': 1, '.claude-ops': 2 });
      expect(ctx.db.kv.get(PINNED_KV_KEY)).toBeUndefined();
    } finally {
      await src.stop();
    }
  });

  it('a Windows profile maps the same way', async () => {
    await writeHomeLayout(home, windowsHome());
    await sessionFile('.claude-work', SID.work, 5102);
    const { ctx } = rig({ pids: [5102] });
    const recs = await createClaudeFilesSource(ctx, { ...SLOW, platform: 'win32' }).scan();
    expect(recs.map((r) => [r.sid, r.account])).toEqual([[SID.work, 1]]);
  });
});

describe('claude-files on Linux and Windows', () => {
  it('Linux ps prints ? for a process with no terminal: the session has no tty', async () => {
    await sessionFile('.claude', SID.plain, 4101);
    await sessionFile('.claude', SID.work, 4102);
    const { ctx } = rig({ mode: 'single', pids: [4101, 4102], ps: [psRow(4101, '?'), psRow(4102, 'pts/7')].join('\n') });
    const src = createClaudeFilesSource(ctx, SLOW);
    await src.start();
    try {
      const st = ctx.store.getState().sessions;
      expect(st[SID.plain]).toBeDefined();
      expect(st[SID.plain]?.tty).toBeUndefined();
      expect(src.ttyFor(SID.plain)).toBeUndefined();
      expect(st[SID.work]?.tty).toBe('pts/7');
    } finally {
      await src.stop();
    }
  });

  it('procps checks pid reuse as on the Mac: another start time drops the session', async () => {
    await sessionFile('.claude', SID.plain, 4101);
    const reused = `   4101 pts/1    ${lstart(NOW - 5 * 60_000)}`;
    const { ctx } = rig({ mode: 'single', pids: [4101], ps: reused });
    expect(await createClaudeFilesSource(ctx, SLOW).scan()).toEqual([]);
  });

  it('Windows: ps is never run; a live pid is a session with no tty, a dead one is gone', async () => {
    await sessionFile('.claude', SID.plain, 5101);
    await sessionFile('.claude', SID.work, 5102);
    const { ctx, exec } = rig({ mode: 'dirs', pids: [5101] });
    const src = createClaudeFilesSource(ctx, { ...SLOW, platform: 'win32' });
    await src.start();
    try {
      await src.scan();
      expect(exec.calls).toEqual([]);
      const st = ctx.store.getState().sessions;
      expect(Object.keys(st)).toEqual([SID.plain]);
      expect(st[SID.plain]?.tty).toBeUndefined();
      expect(st[SID.plain]?.account).toBe(0);
      expect(ctx.log.records.some((e) => /ps failed/u.test(e.msg))).toBe(false);
    } finally {
      await src.stop();
    }
  });
});
