/**
 * Fakes for writer tests: a scriptable terminal, an in-memory transcript
 * reader with real byte offsets, and minimal hooks / ccw / session sources.
 * Nothing here touches a real terminal, process or file.
 */
import type { Move, Pane, PaneForeground, PendingRequest, PlanResponse, SendJob, Session } from '@jantar/protocol';
import { formatLstart, makeSession, toJsonl, type Entry, type EntryContext } from '@jantar/fixtures';
import type {
  CcwLegacySource,
  Notification,
  Notifier,
  OpResult,
  PaneTarget,
  SessionSource,
  TerminalBackend,
  TranscriptEntry,
  TranscriptReader,
  HooksBridge,
} from '../../src/contracts.js';
import { FakeClock } from '../../src/core/clock.js';
import { createFakeExec, createTestContext, fixedProbe, type ExecHandler, type TestContext } from '../../src/core/testing.js';
import { lastLines } from '../../src/terminal/screen.js';
import { createWriterWith, type SendWriter, type WriterOptions } from '../../src/writer/index.js';

export const T0 = '2026-01-15T10:00:00.000Z';
export const SID = '11111111-1111-4111-8111-111111111111';
export const SID2 = '22222222-2222-4222-8222-222222222222';
export const PID = 41001;
export const PID2 = 41002;
export const TTY = '/dev/ttys003';
export const TTY2 = '/dev/ttys004';
export const START_MS = Date.parse('2026-01-15T09:00:00.000Z');
export const CWD = '/synthetic/home/work/alpha-app';
export const TRANSCRIPT = `/synthetic/home/.claude/projects/-synthetic-home-work-alpha-app/${SID}.jsonl`;
export const TRANSCRIPT2 = `/synthetic/home/.claude/projects/-synthetic-home-work-bravo-api/${SID2}.jsonl`;
export const RULE = '─'.repeat(60);

/** Let every pending promise callback run. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise<void>((r) => setImmediate(r));
}

/** Move the fake clock forward in small steps, letting async work run between them. */
export async function advance(clock: FakeClock, ms: number, step = 100): Promise<void> {
  let left = ms;
  await flush();
  while (left > 0) {
    const d = Math.min(step, left);
    clock.advance(d);
    left -= d;
    await flush();
  }
}

// ---------------------------------------------------------------------------
// Transcripts

export class FakeTranscripts implements TranscriptReader {
  readonly files = new Map<string, string>();
  readonly paths = new Map<string, string>();
  reads = 0;

  create(sid: string, path: string, entries: readonly Entry[] = []): void {
    this.paths.set(sid, path);
    this.files.set(path, toJsonl(entries));
  }

  append(sid: string, entries: readonly Entry[]): void {
    const path = this.paths.get(sid);
    if (!path) throw new Error(`no transcript for ${sid}`);
    this.files.set(path, (this.files.get(path) ?? '') + toJsonl(entries));
  }

  /** Append raw text (e.g. half a line). */
  appendRaw(sid: string, raw: string): void {
    const path = this.paths.get(sid) as string;
    this.files.set(path, (this.files.get(path) ?? '') + raw);
  }

  async pathFor(sid: string): Promise<string | null> {
    const p = this.paths.get(sid);
    return p && this.files.has(p) ? p : null;
  }

  async size(path: string): Promise<number> {
    const f = this.files.get(path);
    if (f === undefined) throw new Error('ENOENT');
    return Buffer.byteLength(f);
  }

  async readFrom(path: string, offset: number, opts: { maxBytes?: number } = {}) {
    this.reads += 1;
    const buf = Buffer.from(this.files.get(path) ?? '');
    const end = Math.min(buf.length, offset + (opts.maxBytes ?? buf.length));
    const chunk = buf.subarray(offset, end);
    const lastNl = chunk.lastIndexOf(10);
    if (lastNl < 0) return { entries: [], next: offset };
    const entries: TranscriptEntry[] = [];
    let pos = 0;
    while (pos <= lastNl) {
      const nl = chunk.indexOf(10, pos);
      const line = chunk.subarray(pos, nl);
      if (line.length > 0) {
        try {
          const raw = JSON.parse(line.toString('utf8')) as Record<string, unknown>;
          const e: TranscriptEntry = { offset: offset + pos, length: line.length, type: String(raw.type ?? ''), raw };
          if (typeof raw.uuid === 'string') e.uuid = raw.uuid;
          if (typeof raw.timestamp === 'string') e.timestamp = raw.timestamp;
          if (typeof raw.isSidechain === 'boolean') e.isSidechain = raw.isSidechain;
          entries.push(e);
        } catch {
          // not JSON: skipped, like the real reader
        }
      }
      pos = nl + 1;
    }
    return { entries, next: offset + lastNl + 1 };
  }

  async tail() {
    return {};
  }

  async page() {
    return { items: [], nextBefore: null };
  }
}

// ---------------------------------------------------------------------------
// Terminal

export interface TermCall {
  op: 'find' | 'screen' | 'box' | 'type' | 'enter' | 'clear' | 'focus' | 'fg';
  at: number;
  tty: string;
  text?: string;
}

/** A Claude-like screen: history, then either the input box or a dialog. */
export class FakeTerminal implements TerminalBackend {
  readonly kind = 'terminal-app' as const;
  lastError: { code: string; reason: string } | null = null;
  readonly calls: TermCall[] = [];

  history: string[] = ['⏺ Ready when you are.'];
  /** What is typed in the box. */
  box = '';
  placeholder = 'Try "write a test for the login form"';
  /** When set, drawn instead of the input box. */
  dialog: string | null = null;
  /** Replace the whole screen (ignores history/box/dialog). */
  screenOverride: string | null = null;
  /** The vim mode Claude writes under the box ("NORMAL" -> `-- NORMAL --`); null: vim mode off. */
  vim: string | null = null;
  foreground: PaneForeground = 'claude';
  paneFound = true;
  screenReadable = true;
  styled = false;
  failType = false;
  failEnter = false;
  clearWorks = true;
  /** Simulated time clearInput takes. */
  clearDelayMs = 0;
  enters = 0;
  onType?: (text: string) => void;
  onEnter?: (n: number) => void;

  constructor(
    private readonly clock: FakeClock,
    readonly tty = TTY,
  ) {}

  pane(): Pane {
    return { id: `terminal-app:${this.tty.replace('/dev/', '')}`, backend: 'terminal-app', handle: '1:1', tty: this.tty, foreground: this.foreground };
  }

  render(): string {
    if (this.screenOverride !== null) return this.screenOverride;
    const lines = [...this.history, ''];
    if (this.dialog) {
      lines.push(RULE, ...this.dialog.split('\n'));
    } else {
      const [first = '', ...rest] = (this.box || this.placeholder).split('\n');
      lines.push(RULE, `❯ ${first}`, ...rest.map((l) => `  ${l}`), RULE, ...(this.vim ? [`  -- ${this.vim} --`] : []), '  ⏵⏵ accept edits on (shift+tab to cycle)');
    }
    return lines.join('\n');
  }

  private log(op: TermCall['op'], text?: string): void {
    const c: TermCall = { op, at: this.clock.now(), tty: this.tty };
    if (text !== undefined) c.text = text;
    this.calls.push(c);
  }

  ops(op: TermCall['op']): TermCall[] {
    return this.calls.filter((c) => c.op === op);
  }

  async available(): Promise<boolean> {
    return true;
  }

  async findPane(_target: PaneTarget): Promise<Pane | null> {
    this.log('find');
    if (!this.paneFound) {
      this.lastError = { code: 'not_found', reason: 'that Terminal tab is no longer open' };
      return null;
    }
    return this.pane();
  }

  async readScreen(_pane: Pane, opts: { lines?: number } = {}): Promise<OpResult<{ text: string; at: string }>> {
    this.log('screen');
    if (!this.screenReadable) return { ok: false, code: 'unreadable', reason: 'synthetic read failure' };
    return { ok: true, text: lastLines(this.render(), opts.lines ?? 80).join('\n'), at: this.clock.iso() };
  }

  async readInputBox(_pane: Pane): Promise<OpResult<{ text: string; styled: boolean }>> {
    this.log('box');
    if (!this.screenReadable) return { ok: false, code: 'unreadable', reason: 'synthetic read failure' };
    if (this.dialog || this.screenOverride !== null) return { ok: false, code: 'unreadable', reason: "Claude's input box isn't on screen" };
    return { ok: true, text: this.box.replace(/\s+/g, ' ').trim(), styled: this.styled };
  }

  async type(_pane: Pane, text: string): Promise<OpResult> {
    this.log('type', text);
    if (this.failType) return { ok: false, code: 'failed', reason: 'osascript failed' };
    this.box += text;
    this.onType?.(text);
    return { ok: true };
  }

  async pressEnter(_pane: Pane): Promise<OpResult> {
    this.enters += 1;
    this.log('enter');
    if (this.failEnter) return { ok: false, code: 'failed', reason: 'osascript failed' };
    this.onEnter?.(this.enters);
    return { ok: true };
  }

  async clearInput(_pane: Pane): Promise<OpResult> {
    this.log('clear');
    if (this.clearDelayMs > 0) await this.clock.sleep(this.clearDelayMs);
    if (this.clearWorks) this.box = '';
    return { ok: true };
  }

  async focus(_pane: Pane): Promise<OpResult> {
    this.log('focus');
    return { ok: true };
  }

  async foregroundOf(_pane: Pane): Promise<PaneForeground> {
    this.log('fg');
    return this.foreground;
  }
}

/** Several fake terminals behind one backend, routed by tty. */
export class MultiTerminal implements TerminalBackend {
  readonly kind = 'terminal-app' as const;
  lastError: { code: string; reason: string } | null = null;
  constructor(private readonly byTty: Record<string, FakeTerminal>) {}
  private pick(tty: string | undefined): FakeTerminal {
    const t = tty ? this.byTty[tty] : undefined;
    if (!t) throw new Error(`no fake terminal on ${tty}`);
    return t;
  }
  available() {
    return Promise.resolve(true);
  }
  findPane(target: PaneTarget) {
    return this.pick(target.tty).findPane(target);
  }
  readScreen(p: Pane, o?: { lines?: number }) {
    return this.pick(p.tty).readScreen(p, o);
  }
  readInputBox(p: Pane) {
    return this.pick(p.tty).readInputBox(p);
  }
  type(p: Pane, text: string) {
    return this.pick(p.tty).type(p, text);
  }
  pressEnter(p: Pane) {
    return this.pick(p.tty).pressEnter(p);
  }
  clearInput(p: Pane) {
    return this.pick(p.tty).clearInput(p);
  }
  focus(p: Pane) {
    return this.pick(p.tty).focus(p);
  }
  foregroundOf(p: Pane) {
    return this.pick(p.tty).foregroundOf(p);
  }
}

// ---------------------------------------------------------------------------
// Hooks, ccw, sessions, notifiers

export class FakeHooks implements HooksBridge {
  readonly socketPath = '/synthetic/run/hooks.sock';
  cards: PendingRequest[] = [];
  async start() {}
  async stop() {}
  open() {
    return this.cards;
  }
  get(id: string) {
    return this.cards.find((c) => c.id === id);
  }
  async decide() {
    return { ok: false as const, code: 'not_found' as const, message: 'fake' };
  }
  onHookEvent() {
    return () => {};
  }
  hasHooks() {
    return false;
  }
}

export class FakeCcw implements CcwLegacySource {
  isPresent = true;
  moveMap = new Map<string, Move>();
  locked = new Set<string>();
  throwOnMove = false;
  async start() {}
  async stop() {}
  present() {
    return this.isPresent;
  }
  async botRunning() {
    return false;
  }
  async moves() {
    return [...this.moveMap.values()];
  }
  async moveFor(sid: string) {
    if (this.throwOnMove) throw new Error('synthetic read failure');
    return this.moveMap.get(sid) ?? null;
  }
  async moveLocked(sid: string) {
    return this.locked.has(sid);
  }
  async burn() {
    return [];
  }
  async plan() {
    return {} as PlanResponse;
  }
  async switchConfig() {
    return null;
  }
}

export class FakeSessions implements SessionSource {
  async start() {}
  async stop() {}
  async scan() {
    return [];
  }
  current() {
    return [];
  }
  accountForConfigDir() {
    return null;
  }
}

export class RecordingNotifier implements Notifier {
  readonly channel = 'webpush' as const;
  readonly sent: { n: Notification; at: number }[] = [];
  constructor(private readonly clock: FakeClock) {}
  async send(n: Notification) {
    this.sent.push({ n, at: this.clock.now() });
    return { delivered: 1, failed: 0 };
  }
}

// ---------------------------------------------------------------------------
// ps

/** Fake `ps -o lstart= -p <pid>` (the writer runs it with TZ=UTC). */
export function psLstart(starts: Record<number, number>): ExecHandler {
  return (call) => {
    if (!call.file.endsWith('/ps')) return undefined;
    const i = call.args.indexOf('-p');
    if (call.args[0] !== '-o' || call.args[1] !== 'lstart=' || i < 0) return undefined;
    const pid = Number(call.args[i + 1]);
    const start = starts[pid];
    if (start === undefined) return { code: 1, stdout: '' };
    return { stdout: `${formatLstart(start)}\n` };
  };
}

// ---------------------------------------------------------------------------
// Setup

export interface WriterRig {
  ctx: TestContext;
  clock: FakeClock;
  terminal: FakeTerminal;
  transcripts: FakeTranscripts;
  hooks: FakeHooks;
  ccw: FakeCcw;
  writer: SendWriter;
  probe: ReturnType<typeof fixedProbe>;
  starts: Record<number, number>;
  /** Every send.progress job, in order. */
  progress: SendJob[];
  /** Every event, serialised (to check no prompt text leaks). */
  rawEvents: string[];
  session(over?: Partial<Session>): Session;
  /** Context for transcript builders, timestamped now. */
  at(): EntryContext;
  /** Claude takes whatever is in the box when Enter number `n` is pressed. */
  takeOnEnter(n: number, make?: (box: string, at: EntryContext) => Entry): void;
  jobStages(jobId: string): string[];
}

export interface RigOptions {
  writer?: WriterOptions;
  session?: Partial<Session>;
  /** Entries already in the transcript. */
  history?: (at: EntryContext) => Entry[];
  /** Don't create the transcript file. */
  noTranscript?: boolean;
}

export function makeRig(opts: RigOptions = {}): WriterRig {
  const clock = new FakeClock(T0);
  const starts: Record<number, number> = { [PID]: START_MS, [PID2]: START_MS + 60_000 };
  const exec = createFakeExec(psLstart(starts));
  const probe = fixedProbe([PID, PID2]);
  const ctx = createTestContext({ clock, exec, proc: probe });
  const terminal = new FakeTerminal(clock);
  const transcripts = new FakeTranscripts();
  const hooks = new FakeHooks();
  const ccw = new FakeCcw();
  const progress: SendJob[] = [];
  const rawEvents: string[] = [];
  ctx.store.subscribe((ev) => {
    rawEvents.push(JSON.stringify(ev));
    if (ev.type === 'send.progress') progress.push(ev.data.job);
  });

  const session = (over: Partial<Session> = {}) =>
    makeSession({
      sid: SID,
      pid: PID,
      procStart: formatLstart(START_MS),
      status: 'idle',
      tty: TTY,
      cwd: CWD,
      folder: 'alpha-app',
      name: 'add login form',
      ...over,
    });
  ctx.store.emit({ type: 'session.added', sid: SID, data: { session: session(opts.session) } });

  const at = (): EntryContext => ({ sessionId: SID, cwd: CWD, at: clock.iso() });
  if (!opts.noTranscript) transcripts.create(SID, TRANSCRIPT, opts.history ? opts.history(at()) : []);
  else transcripts.paths.set(SID, TRANSCRIPT);

  const writer = createWriterWith(
    ctx,
    { sessions: new FakeSessions(), terminal, transcripts, hooks, ccwLegacy: ccw },
    opts.writer ?? {},
  );

  return {
    ctx,
    clock,
    terminal,
    transcripts,
    hooks,
    ccw,
    writer,
    probe,
    starts,
    progress,
    rawEvents,
    session,
    at,
    takeOnEnter(n, make) {
      terminal.onEnter = (k) => {
        if (k !== n) return;
        const box = terminal.box;
        if (!transcripts.files.has(TRANSCRIPT)) transcripts.files.set(TRANSCRIPT, '');
        transcripts.append(SID, [make ? make(box, at()) : userEntry(at(), box)]);
        terminal.box = '';
      };
    },
    jobStages(jobId) {
      return progress.filter((j) => j.id === jobId).map((j) => j.stage);
    },
  };
}

/** A user prompt entry (string content), as Claude records a submitted prompt. */
export function userEntry(at: EntryContext, text: string): Entry {
  return {
    type: 'user',
    uuid: `00000000-0000-4000-8000-${String(Date.parse(at.at)).slice(-12).padStart(12, '0')}`,
    parentUuid: null,
    timestamp: at.at,
    sessionId: at.sessionId,
    cwd: at.cwd,
    isSidechain: false,
    userType: 'external',
    message: { role: 'user', content: text },
  };
}

export const PERMISSION_DIALOG = [
  ' Bash command',
  '',
  '   npm test',
  '   Run the synthetic tests',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  "   2. Yes, and don't ask again for npm test commands in /synthetic/home/work/alpha-app",
  '   3. No, and tell Claude what to do differently (esc)',
  '',
  ' Esc to cancel · Tab to amend',
].join('\n');
