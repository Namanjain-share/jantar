/**
 * Fakes for the controls tests: a scriptable terminal (screens that change
 * when a key is pressed), a writer whose pane lock is a real queue, hooks
 * that can emit events, and synthetic Claude screens. Nothing here touches a
 * real terminal, process or file outside a temp dir.
 */
import type { ControlKey, DialogGates, HookPayload, Pane, PaneForeground, SendJob, Session } from '@jantar/protocol';
import { HOOK_TAG, type Settings } from '@jantar/protocol';
import type {
  CcwLegacySource,
  HooksBridge,
  OpResult,
  PaneTarget,
  PressKeyOptions,
  ScreenshotRequest,
  SessionSource,
  SubmitRequest,
  SubmitResult,
  TerminalBackend,
  TerminalShot,
  TranscriptReader,
  Writer,
} from '../../src/contracts.js';
import type { FakeClock } from '../../src/core/clock.js';
import { createTestContext, type TestContext, type TestContextOptions } from '../../src/core/testing.js';
import { buildControlsService } from '../../src/controls/service.js';
import type { ScreenMode } from '../../src/controls/modes.js';
import { findInputBox, screenLines } from '../../src/terminal/screen.js';
import { KeyedQueue } from '../../src/writer/queue.js';

export const T0 = '2026-01-15T10:00:00.000Z';
export const SID = '11111111-1111-4111-8111-111111111111';
export const PID = 41001;
export const TTY = '/dev/ttys003';
export const RULE = '─'.repeat(72);
/** Stands for anything secret a screen might show; it must never reach an audit row, event or reply. */
export const SCREEN_SECRET = 'zq7-SCREEN-SECRET-sk-ant-0000';

const MODE_LINE: Record<ScreenMode, string> = {
  default: '  ⏸ manual mode on (shift+tab to cycle)',
  acceptEdits: '  ⏵⏵ accept edits on (shift+tab to cycle)',
  plan: '  ⏸ plan mode on (shift+tab to cycle)',
  auto: '  ⏵⏵ auto mode on · 4 shells · ↓ to manage',
  dontAsk: "  ⏵⏵ don't ask on",
  bypassPermissions: '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
};

/**
 * Claude idle at its input box, with a mode line (null: none) and a draft
 * (its rows after the first in `more`). `vim` is the vim mode Claude writes
 * under the box ("NORMAL" -> `-- NORMAL --`); none when vim mode is off.
 */
export function claudeScreen(opts: { mode?: ScreenMode | null; draft?: string; more?: string[]; above?: string[]; vim?: string } = {}): string {
  const mode = opts.mode === undefined ? 'default' : opts.mode;
  return [
    '⏺ Done. All synthetic tests pass.',
    ...(opts.above ?? []),
    '',
    RULE,
    `❯ ${opts.draft ?? ''}`,
    ...(opts.more ?? []).map((l) => `  ${l}`),
    RULE,
    ...(opts.vim ? [`  -- ${opts.vim} --`] : []),
    ...(mode ? [MODE_LINE[mode]] : []),
    '',
  ].join('\n');
}

/** A permission prompt, which hides the input box. */
export function dialogScreen(): string {
  return [
    '⏺ Bash(npm test)',
    RULE,
    ' Bash command',
    '',
    `   echo ${SCREEN_SECRET}`,
    '',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    "   2. Yes, and don't ask again for echo commands",
    '   3. No, and tell Claude what to do differently (esc)',
    '',
    ' Esc to cancel · Tab to amend',
  ].join('\n');
}

export function makeSession(over: Partial<Session> = {}): Session {
  return {
    sid: SID,
    pid: PID,
    procStart: 'Thu Jan 15 09:00:00 2026',
    account: 3,
    configDir: '/synthetic/home/.claude-swap-backup/sessions/3-example',
    cwd: '/synthetic/home/work/alpha-app',
    folder: 'alpha-app',
    entrypoint: 'cli',
    status: 'idle',
    statusSource: 'hook',
    statusSince: T0,
    subagentsRunning: 0,
    tty: TTY,
    ...over,
  };
}

export class ScriptedTerminal implements TerminalBackend {
  readonly kind = 'terminal-app' as const;
  screen = claudeScreen();
  /** The tab's height in rows, as Terminal's `number of rows` gives it (null: it won't say). An 80x24 window. */
  tabRows: number | null = 24;
  foreground: PaneForeground = 'claude';
  /** Every key pressed, in order. */
  pressed: ControlKey[] = [];
  /** The options each press came with, in the same order. */
  keyOpts: (PressKeyOptions | undefined)[] = [];
  typed: string[] = [];
  enters = 0;
  /** Called after each key press: change `screen` here. */
  onKey: ((key: ControlKey) => void) | null = null;
  /** Called after typing: change `screen` here. */
  onType: ((text: string) => void) | null = null;
  pressResult: OpResult = { ok: true };
  shotCalls: ScreenshotRequest[] = [];
  /** What getScreenshot answers (a function to answer per call, or to hold a call open). */
  shot: (opts: ScreenshotRequest) => Promise<OpResult<TerminalShot>> = async () => ({ ok: true, ...pngShot() });
  findCalls = 0;
  noPane = false;

  async available() {
    return true;
  }
  async findPane(target: PaneTarget): Promise<Pane | null> {
    this.findCalls += 1;
    if (this.noPane || !target.tty) return null;
    return { id: `terminal-app:${target.tty.replace('/dev/', '')}`, backend: 'terminal-app', handle: '4013:2', tty: target.tty, foreground: this.foreground };
  }
  async readScreen(): Promise<OpResult<{ text: string; at: string; tabRows?: number; raw?: string }>> {
    // v0.4.2: the tab's own text, as the Terminal.app backend returns it for compare-and-type.
    return { ok: true, text: this.screen, at: T0, ...(this.tabRows === null ? {} : { tabRows: this.tabRows }), raw: this.screen };
  }
  async readInputBox(): Promise<OpResult<{ text: string; styled: boolean }>> {
    const box = findInputBox(screenLines(this.screen));
    return box ? { ok: true, text: box.text, styled: false } : { ok: false, code: 'unreadable', reason: 'no box' };
  }
  async type(_pane: Pane, text: string): Promise<OpResult> {
    this.typed.push(text);
    this.onType?.(text);
    return { ok: true };
  }
  async pressEnter(): Promise<OpResult> {
    this.enters += 1;
    return { ok: true };
  }
  async focus(): Promise<OpResult> {
    return { ok: true };
  }
  async foregroundOf(): Promise<PaneForeground> {
    return this.foreground;
  }
  async pressKey(_pane: Pane, key: ControlKey, opts?: PressKeyOptions): Promise<OpResult> {
    // v0.4.2 compare-and-type: typed only while the screen still holds `expect`, like the script's typeif.
    if (opts?.expect !== undefined && !this.screen.includes(opts.expect)) {
      return { ok: false, code: 'changed', reason: 'the terminal changed before Jantar typed' };
    }
    this.pressed.push(key);
    this.keyOpts.push(opts);
    if (this.pressResult.ok) this.onKey?.(key);
    return this.pressResult;
  }
  async getScreenshot(_pane: Pane, opts: ScreenshotRequest = {}): Promise<OpResult<TerminalShot>> {
    this.shotCalls.push(opts);
    return this.shot(opts);
  }
}

/** A tiny valid PNG header (IHDR 1600x1000) with a payload. */
export function pngBytes(width = 1600, height = 1000, extra = 64): Buffer {
  const b = Buffer.alloc(33 + extra);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

export function pngShot(over: Partial<TerminalShot> = {}): TerminalShot {
  return { bytes: pngBytes(), mime: 'image/png', width: 1600, height: 1000, at: T0, windowId: '4013', disturbed: false, ...over };
}

export class LockingWriter implements Writer {
  readonly queue = new KeyedQueue();
  submits: SubmitRequest[] = [];
  /** What submit answers, and the job wait() then returns. */
  submitResult: (req: SubmitRequest) => SubmitResult = (req) => ({ ok: true, job: this.job(req, 'queued'), duplicate: false });
  finalStage: SendJob['stage'] = 'proven';
  finalReason: string | undefined;
  waits: { jobId: string; timeoutMs: number | undefined }[] = [];
  private jobs = new Map<string, SendJob>();

  job(req: SubmitRequest, stage: SendJob['stage']): SendJob {
    const j: SendJob = {
      id: `job-${this.submits.length}`,
      sid: req.sid,
      textHash: 'sha256:synthetic',
      textLength: req.text.length,
      stage,
      attempts: 0,
      createdAt: T0,
      updatedAt: T0,
    };
    this.jobs.set(j.id, j);
    return j;
  }
  async start() {}
  async stop() {}
  async submit(req: SubmitRequest): Promise<SubmitResult> {
    this.submits.push(req);
    return this.submitResult(req);
  }
  get(id: string) {
    return this.jobs.get(id);
  }
  async wait(jobId: string, timeoutMs?: number) {
    this.waits.push({ jobId, timeoutMs });
    const j = this.jobs.get(jobId);
    if (!j) return undefined;
    const done: SendJob = { ...j, stage: this.finalStage, ...(this.finalReason ? { reason: this.finalReason } : {}) };
    return done;
  }
  withPaneLock<T>(pane: Pane, task: () => Promise<T>): Promise<T> {
    return this.queue.run(`tty:${pane.tty}`, task);
  }
}

export class EmittingHooks implements HooksBridge {
  readonly socketPath = '/synthetic/run/hooks.sock';
  private readonly listeners = new Set<(p: HookPayload) => void>();
  constructor(private readonly ctx: TestContext) {}
  async start() {}
  async stop() {}
  open() {
    return Object.values(this.ctx.store.getState().pending).filter((p) => p.state === 'open');
  }
  get(id: string) {
    return this.ctx.store.getState().pending[id];
  }
  async decide() {
    return { ok: false as const, code: 'not_found' as const, message: 'not used' };
  }
  onHookEvent(fn: (p: HookPayload) => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  hasHooks() {
    return true;
  }
  listening(): number {
    return this.listeners.size;
  }
  emit(over: Partial<HookPayload> & { hook_event_name: string; session_id: string }, ppid = PID): void {
    const p = { [HOOK_TAG]: { v: 1, ts: Date.parse(T0), ppid, wait: false }, ...over } as HookPayload;
    for (const fn of [...this.listeners]) fn(p);
  }
}

export class QuietCcw implements CcwLegacySource {
  moving: string | null = null;
  async start() {}
  async stop() {}
  present() {
    return this.moving !== null;
  }
  async botRunning() {
    return false;
  }
  async moves() {
    return [];
  }
  async moveFor() {
    return null;
  }
  async moveLocked() {
    return this.moving !== null;
  }
  async burn() {
    return [];
  }
  async plan() {
    return { source: 'none' as const, next: null, accounts: [], updatedAt: null };
  }
  async switchConfig() {
    return null;
  }
}

const NO_SESSIONS: SessionSource = {
  start: async () => {},
  stop: async () => {},
  scan: async () => [],
  current: () => [],
  accountForConfigDir: () => null,
};

const NO_TRANSCRIPTS = {} as TranscriptReader;

export interface Rig {
  ctx: TestContext;
  clock: FakeClock;
  terminal: ScriptedTerminal;
  writer: LockingWriter;
  hooks: EmittingHooks;
  ccw: QuietCcw;
  controls: ReturnType<typeof buildControlsService>;
}

/** `gates`: the dialog gates the screen path and the keypad read with (default: the shipped DIALOG_GATES). */
export function makeRig(opts: { settings?: Settings; session?: Partial<Session>; ctx?: TestContextOptions; gates?: DialogGates } = {}): Rig {
  const ctx = createTestContext({ ...opts.ctx, ...(opts.settings ? { settings: opts.settings } : {}) });
  const terminal = new ScriptedTerminal();
  const writer = new LockingWriter();
  const hooks = new EmittingHooks(ctx);
  const ccw = new QuietCcw();
  const session = makeSession(opts.session);
  ctx.store.emit({ type: 'session.added', sid: session.sid, data: { session } });
  const controls = buildControlsService(ctx, { sessions: NO_SESSIONS, terminal, writer, hooks, transcripts: NO_TRANSCRIPTS, ccwLegacy: ccw }, opts.gates);
  return { ctx, clock: ctx.clock, terminal, writer, hooks, ccw, controls };
}

/** Let every pending promise callback run. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise<void>((r) => setImmediate(r));
}

/** Run `p` to the end, moving the fake clock forward in small steps while it waits. */
export async function drive<T>(clock: FakeClock, p: Promise<T>, step = 50, maxMs = 120_000): Promise<T> {
  let done = false;
  const out = p.finally(() => {
    done = true;
  });
  await flush();
  for (let t = 0; !done && t < maxMs; t += step) {
    clock.advance(step);
    await flush();
  }
  if (!done) throw new Error('did not settle');
  return out;
}

export const CLI = { kind: 'cli' } as const;
export const PHONE = { kind: 'device', deviceId: 'dev-1', scopes: ['read', 'control'] } as const;
export const READER = { kind: 'device', deviceId: 'dev-2', scopes: ['read'] } as const;
