/**
 * v0.6 Fleet: starting a session on a Linux node whose accounts are config
 * dirs (accountsMode "dirs", spec 5), through the launcher service, the
 * dirs usage source's roster and the tmux backend on a scripted tmux.
 *
 * - The account choice runs on the config-dir rules (account.ts with `mode`):
 *   Auto is ~/.claude (0), every row is selectable with no usage, and a
 *   manual pick of `work` is not refused for having no usage reading.
 * - The line typed into the new tmux session: `env -u CLAUDE_CONFIG_DIR`
 *   before claude for ~/.claude, `env CLAUDE_CONFIG_DIR=<dir>` for
 *   ~/.claude-work.
 * - A dir that lost its .claude.json since the roster was listed is refused,
 *   never started on ~/.claude while the job says another account.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingsSchema, V03_LAUNCH_FLAGS, type LaunchStartBody } from '@jantar/protocol';
import type { SessionSource, UsageSource } from '../../src/contracts.js';
import { createFakeExec, createTestContext, onCommand, type TestContext } from '../../src/core/testing.js';
import { DIRS_DEFAULT_REASON } from '../../src/launcher/account.js';
import { noWindows } from '../../src/launcher/launcher.js';
import { LauncherService } from '../../src/launcher/service.js';
import { createDirsUsageSource } from '../../src/sources/cswap/dirs.js';
import { TmuxBackend } from '../../src/terminal/tmux/index.js';
import { SOCKET, TMUX_BIN, createFakeTmux, type FakeTmux } from '../terminal/tmux/fake-tmux.js';
import { FakeCcw, FakeLaunchWriter, FakePolicy, RecordingNotifier, T0, advance, device, filesWith, flush } from './helpers.js';

const CLAUDE = '/home/sam/.local/bin/claude';
const PHONE = device();

const noSessions: SessionSource = { start: async () => {}, stop: async () => {}, scan: async () => [], current: () => [], accountForConfigDir: () => null };
const noUsage: UsageSource = {
  start: async () => {},
  stop: async () => {},
  read: async () => null,
  latest: () => null,
  requestRefresh: () => ({ queued: false, nextAllowedAt: null }),
  isPolling: () => false,
};

let tmp: string;
let home: string;
let folder: string;
let ctx: TestContext;
let fake: FakeTmux;
let launcher: LauncherService;
let stopUsage: () => Promise<void>;

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'jantar-dirs-launch-')));
  home = join(tmp, 'home', 'sam');
  folder = join(tmp, 'work', 'api-server');
  await mkdir(join(home, '.claude'), { recursive: true });
  await mkdir(join(home, '.claude-work'), { recursive: true });
  await writeFile(join(home, '.claude-work', '.claude.json'), '{}\n');
  await mkdir(folder, { recursive: true });
  fake = createFakeTmux();
  const exec = createFakeExec(fake.handler, onCommand('ps', { stdout: '', code: 1 }));
  ctx = createTestContext({
    userHome: home,
    accountsMode: 'dirs',
    exec,
    bins: { tmux: TMUX_BIN, ps: '/usr/bin/ps', claude: CLAUDE, cswap: null },
    settings: SettingsSchema.parse({ launch: { enabled: true, mode: 'claude', defaultFlags: V03_LAUNCH_FLAGS } }),
    env: { HOME: home, LC_ALL: 'C', TZ: 'UTC' },
  });
  ctx.clock.set(T0);
  const usage = createDirsUsageSource(ctx);
  await usage.start();
  stopUsage = () => usage.stop();
  launcher = new LauncherService(ctx, {
    sessions: noSessions,
    terminal: new TmuxBackend(ctx, { socket: SOCKET }),
    writer: new FakeLaunchWriter(ctx),
    usage: noUsage,
    ccwLegacy: new FakeCcw(),
    files: filesWith(new FakePolicy([{ id: 'r.work', label: 'work', real: join(tmp, 'work'), display: '~/work' }])),
    notifiers: [new RecordingNotifier()],
  });
  await launcher.start();
});

afterEach(async () => {
  await launcher.stop();
  await stopUsage();
  await rm(tmp, { recursive: true, force: true });
});

const body = (over: Partial<LaunchStartBody> = {}): LaunchStartBody => ({ root: 'r.work', path: 'api-server', account: 'auto', flags: { ...V03_LAUNCH_FLAGS }, ...over });

/** What the new tmux session's shell got: the launch line and its Return. */
async function typedLine(): Promise<string> {
  // the run answers the API first (a sleep of 0 on the fake clock), then opens the window
  for (let i = 0; i < 20 && !fake.panes[0]?.input; i++) await advance(ctx.clock, 50, 50);
  return fake.panes[0]?.input ?? '';
}

describe('a dirs node starts sessions on its config dirs', () => {
  it('preview: Auto is ~/.claude, every row selectable with no usage, no stale warning; the line clears CLAUDE_CONFIG_DIR', async () => {
    const r = await launcher.preview({ root: 'r.work', path: 'api-server', account: 'auto' }, PHONE);
    if (!r.ok) throw new Error(r.reason);
    expect(r.preview.account).toEqual({ pick: 0, source: 'auto', reason: DIRS_DEFAULT_REASON });
    expect(r.preview.accounts).toEqual([
      { id: 0, label: 'claude', live: 0, selectable: true, held: false },
      { id: 1, label: 'work', live: 0, selectable: true, held: false },
    ]);
    expect(r.preview.warnings).toEqual([]);
    expect(r.preview.command).toMatch(new RegExp(`^cd -- ${folder} && env -u CLAUDE_CONFIG_DIR ${CLAUDE} `, 'u'));
    // a stale roster is no reason for a "usage readings" warning
    ctx.clock.advance(30 * 60_000);
    const later = await launcher.preview({ root: 'r.work', path: 'api-server', account: 'auto' }, PHONE);
    expect(later.ok && later.preview.warnings).toEqual([]);
  });

  it('start on Auto: account 0, typed with env -u CLAUDE_CONFIG_DIR into a new tmux session', async () => {
    const r = await launcher.launch(body(), PHONE, 'k-auto');
    if (!r.ok) throw new Error(`${r.code}: ${r.reason}`);
    expect(r.job).toMatchObject({ account: 0, accountSource: 'auto' });
    expect(await typedLine()).toMatch(new RegExp(`^cd -- ${folder} && env -u CLAUDE_CONFIG_DIR ${CLAUDE} .*--session-id ${r.job.sid} --name api-server\\r$`, 'u'));
  });

  it('a manual pick of work: not refused for having no usage, typed as env CLAUDE_CONFIG_DIR=<its dir>', async () => {
    const preview = await launcher.preview({ root: 'r.work', path: 'api-server', account: 1 }, PHONE);
    if (!preview.ok) throw new Error(preview.reason);
    expect(preview.preview.account).toMatchObject({ pick: 1, source: 'manual' });
    expect(preview.preview.command).toContain(`&& env CLAUDE_CONFIG_DIR=${join(home, '.claude-work')} ${CLAUDE} `);
    const r = await launcher.launch(body({ account: 1 }), PHONE, 'k-work');
    if (!r.ok) throw new Error(`${r.code}: ${r.reason}`);
    expect(r.job).toMatchObject({ account: 1, accountSource: 'manual' });
    expect(await typedLine()).toContain(`&& env CLAUDE_CONFIG_DIR=${join(home, '.claude-work')} ${CLAUDE} `);
  });

  it('a dir that lost its .claude.json since the roster was listed is refused, not started on ~/.claude', async () => {
    await rm(join(home, '.claude-work', '.claude.json'));
    expect(ctx.store.getState().accounts[1]?.alias).toBe('work');
    const r = await launcher.launch(body({ account: 1 }), PHONE, 'k-gone');
    expect(r).toMatchObject({ ok: false, code: 'refused', reason: "01's config dir is no longer on this machine (no .claude.json in it)" });
    await flush();
    expect(fake.calls.filter((c) => c[0] === 'new-session')).toEqual([]);
  });

  it('a server with no usable tmux says so in its own words, never "This Mac"', () => {
    expect(noWindows({ kind: 'tmux' })).toBe("This server has no tmux 3.2 or later, so Jantar can't open a new window there");
    expect(noWindows({ kind: 'terminal-app' })).toBe("This Mac's terminal can't open new windows");
  });
});
