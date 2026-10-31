/**
 * Fakes for the launcher's tests: a path policy over a temp dir (WP-FP's
 * real one is built in parallel), a Terminal backend whose new window is a
 * screen the test writes, a writer that records submits, a ccw source, and
 * synthetic Claude screens. Nothing here runs osascript, cswap or claude, or
 * touches a real Terminal tab.
 */
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SettingsSchema,
  V03_LAUNCH_FLAGS,
  type Account,
  type ControlKey,
  type Move,
  type Pane,
  type PaneForeground,
  type PlanResponse,
  type Scope,
  type SendJob,
  type SendStage,
  type Session,
  type Settings,
} from '@jantar/protocol';
import type {
  CcwBurn,
  CcwLegacySource,
  DirEntryInfo,
  FilePolicy,
  FileRefusal,
  FilesService,
  Notification,
  Notifier,
  OpResult,
  PaneTarget,
  PressKeyOptions,
  ResolvedRoot,
  SessionSource,
  SubmitRequest,
  SubmitResult,
  TerminalBackend,
  TerminalErrorCode,
  UsageSource,
  Writer,
} from '../../src/contracts.js';
import { actorId } from '../../src/core/actor.js';
import type { FakeClock } from '../../src/core/clock.js';
import { sha256Hex } from '../../src/core/hash.js';
import { newId } from '../../src/core/ids.js';
import { createFakeExec, createTestContext, notBuiltParts, onCommand, type TestContext } from '../../src/core/testing.js';
import { LauncherService, type LauncherOptions } from '../../src/launcher/service.js';

export const T0 = '2026-01-15T10:00:00.000Z';

// ---------------------------------------------------------------------------
// Time

export async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise<void>((r) => setImmediate(r));
  // Fake time must not run ahead of a real fs call still in flight (a realpath or stat on a slow machine).
  const end = Date.now() + 2_000;
  while (Date.now() < end && process.getActiveResourcesInfo().some((t) => t.startsWith('FSReq'))) {
    await new Promise<void>((r) => setTimeout(r, 1));
    for (let i = 0; i < 4; i++) await new Promise<void>((r) => setImmediate(r));
  }
}

/** Move the fake clock forward in steps, letting async work (and real fs calls) run between them. */
export async function advance(clock: FakeClock, ms: number, step = 250): Promise<void> {
  let left = ms;
  await flush();
  while (left > 0) {
    const d = Math.min(step, left);
    clock.advance(d);
    left -= d;
    await flush();
  }
}

/** Wait in real time (fs calls finishing) until `done()` holds; at most `ms`. */
export async function settle(done: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise<void>((r) => setTimeout(r, 2));
  }
}

/** Advance until `done()` holds (or fail after `maxMs` of fake time). */
export async function until(clock: FakeClock, done: () => boolean, maxMs = 600_000, step = 250): Promise<void> {
  await flush();
  for (let t = 0; t <= maxMs; t += step) {
    if (done()) return;
    clock.advance(step);
    await flush();
  }
  // A real fs call can still be in flight on a slow machine: give it real time (no more fake time) before failing.
  const end = Date.now() + 5_000;
  while (!done() && Date.now() < end) await new Promise<void>((r) => setTimeout(r, 5));
  if (!done()) throw new Error(`condition not met within ${maxMs} ms of fake time`);
}

// ---------------------------------------------------------------------------
// Screens (Claude Code 2.x layout; every name and path is made up)

export const RULE = '─'.repeat(72);
const BANNER = [' ▐▛███▛▌   Claude Code v2.1.300', '▝▜█████▛▘  Synthetic model · API Usage Billing', '  ▘▘ ▝▝    ~/work/alpha-app', ''];

export const READY_SCREEN = [...BANNER, RULE, '❯ Try "write a test for the login form"', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)', ''].join('\n');

export const STARTING_SCREEN = [...BANNER, '✻ Starting…'].join('\n');

/** The trust dialog with the pointer on option `at` (0: "No, exit"). */
export function trustScreen(at: 0 | 1 = 0): string {
  const opts = ['No, exit', 'Yes, I trust this folder'].map((o, i) => (i === at ? ` ❯ ${o}` : `   ${o}`));
  return [
    RULE,
    ' Accessing workspace:',
    '',
    ' /synthetic/work/alpha-app',
    '',
    ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source',
    " project, or work from your team). If not, take a moment to review what's in this folder first.",
    '',
    ...opts,
    '',
    ' Enter to confirm · Esc to cancel',
  ].join('\n');
}

export const CHROME_SCREEN = [
  RULE,
  ' Claude in Chrome',
  '',
  ' Claude in Chrome works with the Chrome extension to drive your browser.',
  ' For more info, use /chrome',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n');

export const RETRY_SCREEN = [RULE, " Claude Code can't start this session yet", '', ' ❯ 1. Retry now', '   2. Exit', '', ' Enter to confirm · Esc to cancel'].join('\n');

export const KEEP_MODEL_SCREEN = [
  RULE,
  ' You’re resuming with an older model',
  '',
  ' A newer model is available.',
  ' ❯ 1. Keep Synthetic model',
  '   2. Switch to the newer model',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n');

export const BYPASS_SCREEN = [
  RULE,
  ' WARNING: Claude Code running in Bypass Permissions mode',
  '',
  ' In Bypass Permissions mode, Claude Code will not ask for your approval before running commands.',
  '',
  ' ❯ 1. No, exit',
  '   2. Yes, I accept',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n');

export const LOGIN_SCREEN = [
  ...BANNER,
  ' Select login method:',
  '',
  ' ❯ 1. Claude account with subscription',
  '   2. Anthropic Console account',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n');

/** A key-shaped string, built by concatenation so the repo's secret scan never matches this file. */
export const FAKE_KEY = 'sk-' + 'ant-api03-SYNTHETICSYNTHETIC';

export const UPDATE_SCREEN = [
  RULE,
  ` A new version is ready (mail ops@example.org, key ${FAKE_KEY})`,
  '',
  ' ❯ 1. Update now',
  '   2. Later',
  '   3. Never ask again',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n');

export const SHELL_PROMPT = 'Last login: Thu Jan 15 09:59:58 on ttys014\nsynthetic@mac ~ % ';
export const CS_MISSING_SCREEN = `${SHELL_PROMPT}cd -- /synthetic/work/alpha-app && cs 7 -- --chrome\nzsh: command not found: cs\nsynthetic@mac alpha-app % `;

// ---------------------------------------------------------------------------
// Path policy over a temp dir

const DENY = new Set(['.ssh', '.env', 'id_rsa', '.aws']);

export interface PolicyRoot {
  id: string;
  label: string;
  /** Realpath. */
  real: string;
  display: string;
}

/** A small FilePolicy: realpath containment, a name denylist, dirs only. Enough to test the launcher against. */
export class FakePolicy implements FilePolicy {
  calls: string[] = [];
  constructor(readonly list: PolicyRoot[]) {}

  async roots(): Promise<ResolvedRoot[]> {
    return this.list.map((r) => ({ id: r.id, kind: 'configured' as const, label: r.label, real: r.real, display: r.display, home: false }));
  }

  async root(rootId: string): Promise<ResolvedRoot | null> {
    return (await this.roots()).find((r) => r.id === rootId) ?? null;
  }

  async openForRead(): Promise<never> {
    throw new Error('the launcher never opens files');
  }

  isProtected(absPath: string): boolean {
    return absPath.split('/').some((seg) => DENY.has(seg));
  }

  async resolveDir(rootId: string, rel: string) {
    this.calls.push(`resolveDir:${rootId}:${rel}`);
    const root = await this.root(rootId);
    if (!root) return refusal('no_root', 'no such root');
    if (rel.startsWith('/') || rel.includes('\\') || /[\u0000-\u001f]/u.test(rel)) return refusal('bad_path', 'bad path');
    const segs = rel.split('/').filter((s, i, a) => !(s === '' && (i === 0 || i === a.length - 1)));
    if (segs.some((s) => s === '' || s === '.' || s === '..')) return refusal('bad_path', 'bad path');
    const clean = segs.join('/');
    if (segs.some((s) => DENY.has(s))) return refusal('protected', 'that folder is protected');
    let real: string;
    try {
      real = await realpath(join(root.real, clean));
    } catch {
      return refusal('missing', 'no such folder');
    }
    if (real !== root.real && !real.startsWith(`${root.real}/`)) return refusal('outside', 'that folder is outside its root');
    if (!(await stat(real)).isDirectory()) return refusal('not_dir', 'not a folder');
    return { real, rel: clean, root, display: clean ? `${root.display}/${clean}` : root.display };
  }

  async openDir(rootId: string, rel: string, opts: { hidden?: boolean; dirsOnly?: boolean } = {}) {
    this.calls.push(`openDir:${rootId}:${rel}`);
    const dir = await this.resolveDir(rootId, rel);
    if ('refused' in dir) return dir;
    const entries: DirEntryInfo[] = [];
    let hiddenProtected = 0;
    for (const d of await readdir(dir.real, { withFileTypes: true })) {
      if (DENY.has(d.name)) {
        hiddenProtected += 1;
        continue;
      }
      if (!opts.hidden && d.name.startsWith('.')) continue;
      if (d.isSymbolicLink()) {
        let link: DirEntryInfo['link'] = 'broken';
        try {
          const to = await realpath(join(dir.real, d.name));
          link = to === dir.root.real || to.startsWith(`${dir.root.real}/`) ? 'inside' : 'outside';
        } catch {
          link = 'broken';
        }
        entries.push({ name: d.name, type: 'link', link });
      } else if (d.isDirectory()) {
        entries.push({ name: d.name, type: 'dir' });
      } else if (!opts.dirsOnly) {
        entries.push({ name: d.name, type: d.isFile() ? 'file' : 'other' });
      }
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    return { real: dir.real, rel: dir.rel, root: dir.root, entries, hiddenProtected, truncated: false };
  }

  async underRoot(absPath: string): Promise<boolean> {
    return this.list.some((r) => absPath === r.real || absPath.startsWith(`${r.real}/`));
  }

  async locate(absPath: string) {
    let real: string;
    try {
      real = await realpath(absPath);
    } catch {
      return refusal('missing', 'gone');
    }
    for (const r of this.list) {
      if (real === r.real) return { rootId: r.id, rel: '' };
      if (real.startsWith(`${r.real}/`)) return { rootId: r.id, rel: real.slice(r.real.length + 1) };
    }
    return refusal('outside', 'not under a root');
  }
}

function refusal(refused: FileRefusal['refused'], message: string): FileRefusal {
  return { refused, message };
}

export function filesWith(policy: FilePolicy): FilesService {
  return { ...notBuiltParts().files, policy };
}

// ---------------------------------------------------------------------------
// Terminal

/** The new window, as the launcher sees it: the screen and foreground are whatever the test sets. */
export class FakeBackend implements TerminalBackend {
  readonly kind = 'terminal-app' as const;
  opened: string[] = [];
  openResult: OpResult<{ tty: string; windowId: string }> | null = null;
  fg: PaneForeground = 'claude';
  screen = STARTING_SCREEN;
  screenResult: OpResult<{ text: string; at: string }> | null = null;
  keys: { key: ControlKey; repeat?: number }[] = [];
  /** Called after each key, e.g. to put the next screen up. */
  onKey: ((key: ControlKey, opts?: PressKeyOptions) => void) | null = null;
  pressResult: OpResult | null = null;
  calls: string[] = [];
  avail = true;
  /** findPane finds nothing and says why, as Terminal.app's backend does (lastError). */
  findError: { code: TerminalErrorCode; reason: string } | null = null;
  lastError: { code: TerminalErrorCode; reason: string } | null = null;
  /** The window id in findPane's handle ("<window id>:<tab index>"). */
  windowId = '9001';
  /** `ps -t <tty> -o lstart=` for the window's tty (its oldest process first); null: no process there. */
  ttyStarts: string[] | null = ['Thu Jan 15 10:00:00 2026'];

  async available() {
    return this.avail;
  }
  async findPane(target: PaneTarget): Promise<Pane | null> {
    this.calls.push(`findPane:${target.tty ?? '-'}`);
    this.lastError = this.findError;
    if (this.findError || !target.tty) return null;
    return { id: `terminal-app:${target.tty.replace('/dev/', '')}`, backend: 'terminal-app', handle: `${this.windowId}:1`, tty: target.tty, foreground: this.fg };
  }
  async readScreen() {
    return this.screenResult ?? { ok: true as const, text: this.screen, at: T0 };
  }
  async readInputBox() {
    return { ok: true as const, text: '', styled: false };
  }
  async type(): Promise<OpResult> {
    this.calls.push('type');
    return { ok: true };
  }
  async pressEnter(): Promise<OpResult> {
    this.calls.push('pressEnter');
    return { ok: true };
  }
  async focus(): Promise<OpResult> {
    this.calls.push('focus');
    return { ok: true };
  }
  async foregroundOf(): Promise<PaneForeground> {
    return this.fg;
  }
  async openWindow(command: string): Promise<OpResult<{ tty: string; windowId: string }>> {
    this.opened.push(command);
    return this.openResult ?? { ok: true, tty: '/dev/ttys014', windowId: '9001' };
  }
  async pressKey(_pane: Pane, key: ControlKey, opts?: PressKeyOptions): Promise<OpResult> {
    this.keys.push(opts?.repeat ? { key, repeat: opts.repeat } : { key });
    const r = this.pressResult ?? { ok: true as const };
    if (r.ok) this.onKey?.(key, opts);
    return r;
  }
}

// ---------------------------------------------------------------------------
// Writer, ccw, notifiers

export class FakeLaunchWriter implements Writer {
  submits: SubmitRequest[] = [];
  locks = 0;
  jobs = new Map<string, SendJob>();
  /** Answer submit() with this instead (e.g. a refusal). */
  submitResult: ((req: SubmitRequest) => SubmitResult) | null = null;
  finalStage: SendStage = 'proven';
  constructor(private readonly ctx: TestContext) {}
  async start() {}
  async stop() {}
  async submit(req: SubmitRequest): Promise<SubmitResult> {
    this.submits.push(req);
    if (this.submitResult) return this.submitResult(req);
    const at = this.ctx.clock.iso();
    const job: SendJob = {
      id: newId(),
      sid: req.sid,
      textHash: sha256Hex(req.text),
      textLength: req.text.length,
      stage: 'queued',
      attempts: 0,
      actor: actorId(req.actor),
      createdAt: at,
      updatedAt: at,
    };
    if (req.idempotencyKey) job.idempotencyKey = req.idempotencyKey;
    this.jobs.set(job.id, job);
    return { ok: true, job, duplicate: false };
  }
  get(id: string) {
    return this.jobs.get(id);
  }
  async wait(id: string) {
    const j = this.jobs.get(id);
    return j ? { ...j, stage: this.finalStage, ...(this.finalStage === 'failed' ? { reason: 'no proof in the transcript' } : {}) } : undefined;
  }
  withPaneLock<T>(_pane: Pane, task: () => Promise<T>): Promise<T> {
    this.locks += 1;
    return task();
  }
}

export class FakeCcw implements CcwLegacySource {
  isPresent = false;
  hold: number[] = [];
  groups: string[][] = [];
  ceiling: number | undefined;
  movesFor = new Map<string, Move>();
  async start() {}
  async stop() {}
  present() {
    return this.isPresent;
  }
  async botRunning() {
    return this.isPresent;
  }
  async moves() {
    return [...this.movesFor.values()];
  }
  async moveFor(sid: string) {
    return this.movesFor.get(sid) ?? null;
  }
  async moveLocked() {
    return false;
  }
  async burn(): Promise<CcwBurn[]> {
    return [];
  }
  async plan(): Promise<PlanResponse> {
    return { source: 'ccw-legacy', next: null, accounts: [], updatedAt: T0, ...(this.ceiling !== undefined ? { ceiling: this.ceiling } : {}) };
  }
  async switchConfig() {
    return this.isPresent ? { on: true, dryRun: false, hold: this.hold, groups: this.groups } : null;
  }
}

export class RecordingNotifier implements Notifier {
  readonly channel = 'webpush' as const;
  sent: Notification[] = [];
  async send(n: Notification) {
    this.sent.push(n);
    return { delivered: 1, failed: 0 };
  }
}

const noSessions: SessionSource = {
  start: async () => {},
  stop: async () => {},
  scan: async () => [],
  current: () => [],
  accountForConfigDir: () => null,
};

const noUsage: UsageSource = {
  start: async () => {},
  stop: async () => {},
  read: async () => null,
  latest: () => null,
  requestRefresh: () => ({ queued: false, nextAllowedAt: null }),
  isPolling: () => false,
};

// ---------------------------------------------------------------------------
// Models

export function account(id: number, fivePct: number, over: Partial<Account> & { sevenPct?: number; resetsAt?: string } = {}): Account {
  const { sevenPct, resetsAt, ...rest } = over;
  return {
    id,
    emailMasked: 'a***@e***.com',
    isDefaultLogin: false,
    disabled: false,
    held: false,
    usageStatus: 'ok',
    windows: [
      { kind: 'five_hour', pct: fivePct, resetsAt: resetsAt ?? '2026-01-15T13:40:00.000Z' },
      { kind: 'seven_day', pct: sevenPct ?? 20, resetsAt: '2026-01-20T00:00:00.000Z' },
    ],
    ...rest,
  };
}

export function session(over: Partial<Session> & { sid: string }): Session {
  return {
    pid: 41001,
    procStart: 'Thu Jan 15 10:00:01 2026',
    account: 7,
    configDir: '/synthetic/home/.claude-swap-backup/sessions/7-example',
    cwd: '/synthetic/work/alpha-app',
    folder: 'alpha-app',
    entrypoint: 'cli',
    status: 'idle',
    statusSource: 'session-file',
    statusSince: T0,
    subagentsRunning: 0,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The rig

export interface Rig {
  ctx: TestContext;
  /** The temp dir; the root "r.work" is <tmp>/work. */
  tmp: string;
  work: string;
  policy: FakePolicy;
  terminal: FakeBackend;
  writer: FakeLaunchWriter;
  ccw: FakeCcw;
  notifier: RecordingNotifier;
  launcher: LauncherService;
  close(): Promise<void>;
}

export interface RigOptions {
  settings?: Record<string, unknown>;
  accounts?: Account[];
  /** Folders to create under the root (relative paths). */
  folders?: string[];
  launcher?: LauncherOptions;
  start?: boolean;
  /** Replace the recording notifier (e.g. with a real WebPushNotifier). */
  notifiers?: (ctx: TestContext) => Notifier[];
}

/** 1, 2 and 5 have the most room and are the rig's kept accounts (KEPT), so a picker that forgets them is caught. */
export const DEFAULT_ACCOUNTS = (): Account[] => [
  account(1, 5),
  account(2, 3),
  account(3, 60),
  account(4, 40),
  account(5, 1),
  account(7, 12),
];

/** The rig's synthetic settings accounts.kept. */
export const KEPT = [1, 2, 5];

export async function makeRig(opts: RigOptions = {}): Promise<Rig> {
  const tmp = await realpath(await mkdtemp(join(tmpdir(), 'ccw-launcher-')));
  const work = join(tmp, 'work');
  await mkdir(work);
  for (const f of opts.folders ?? ['alpha-app', 'beta']) await mkdir(join(work, f), { recursive: true });
  // v0.4 starts in claude mode by default; these tests type `cs N --` (cs-shell) unless they say otherwise.
  const over = (opts.settings ?? {}) as { launch?: Record<string, unknown> };
  const settings: Settings = SettingsSchema.parse({
    accounts: { kept: KEPT },
    ...opts.settings,
    launch: { enabled: true, mode: 'cs-shell', defaultFlags: V03_LAUNCH_FLAGS, ...over.launch },
  });
  const terminal = new FakeBackend();
  // Restart recovery asks ps when the stored tty's tab started.
  const exec = createFakeExec(onCommand('ps', () => (terminal.ttyStarts === null ? { code: 1 } : { stdout: terminal.ttyStarts.map((t) => `${t}\n`).join('') }), ['-t']));
  const ctx = createTestContext({ settings, exec, env: { HOME: '/synthetic/home', LC_ALL: 'C', TZ: 'UTC' } });
  ctx.clock.set(T0);
  const policy = new FakePolicy([{ id: 'r.work', label: 'work', real: work, display: '~/work' }]);
  const writer = new FakeLaunchWriter(ctx);
  const ccw = new FakeCcw();
  const notifier = new RecordingNotifier();
  ctx.store.emit({ type: 'usage.updated', data: { accounts: opts.accounts ?? DEFAULT_ACCOUNTS(), activeAccount: null, fetchedAt: T0, source: 'cache' } });
  const launcher = new LauncherService(
    ctx,
    {
      sessions: noSessions,
      terminal,
      writer,
      usage: noUsage,
      ccwLegacy: ccw,
      files: filesWith(policy),
      notifiers: opts.notifiers?.(ctx) ?? [notifier],
    },
    opts.launcher,
  );
  if (opts.start !== false) await launcher.start();
  return {
    ctx,
    tmp,
    work,
    policy,
    terminal,
    writer,
    ccw,
    notifier,
    launcher,
    async close() {
      await launcher.stop();
      await rm(tmp, { recursive: true, force: true });
    },
  };
}

/** A device actor with these scopes. */
export function device(id = 'dev-phone', scopes: Scope[] = ['read', 'control', 'launch']) {
  return { kind: 'device' as const, deviceId: id, scopes };
}

/** Is `p` a directory? (lstat: a symlink is not.) */
export async function isDir(p: string): Promise<boolean> {
  try {
    return (await lstat(p)).isDirectory();
  } catch {
    return false;
  }
}
