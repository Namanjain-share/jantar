/**
 * Fakes for every part the API depends on, plus helpers to build an API on a
 * test context and pair devices. Nothing here touches the real machine.
 */
import type {
  DecisionBody,
  Pane,
  PendingRequest,
  PlanResponse,
  Scope,
  SendJob,
  Session,
  TranscriptItem,
} from '@jantar/protocol';
import { DEVICE_COOKIE, DEVICE_SECRET_HEADER } from '@jantar/protocol';
import type {
  Actor,
  CcwBurn,
  CcwLegacySource,
  DecideResult,
  HooksBridge,
  Notifier,
  OpResult,
  PaneTarget,
  SessionSource,
  SubmitRequest,
  SubmitResult,
  TerminalBackend,
  TranscriptReader,
  TranscriptWatcher,
  UsageSource,
  Writer,
} from '../../src/contracts.js';
import { actorId } from '../../src/core/actor.js';
import { sha256Hex } from '../../src/core/hash.js';
import { newId, newSecretId } from '../../src/core/ids.js';
import { createTestContext, notBuiltParts, type NotBuiltParts, type TestContext, type TestContextOptions } from '../../src/core/testing.js';
import { buildApp } from '../../src/api/app.js';
import { ApiServices, type ApiDeps, type ApiOptions } from '../../src/api/services.js';
import { WebPushNotifier, type PushSender } from '../../src/notify/webpush.js';

export const PORT = 7420;
export const ORIGIN = `http://127.0.0.1:${PORT}`;
export const HOST = `127.0.0.1:${PORT}`;
export const TEST_VAPID = {
  publicKey: 'BTestPublicKey_not_a_real_key_0123456789abcdefghijklmnopqrstuvwxyz',
  privateKey: 'test-private-key',
  subject: 'mailto:test@example.com',
  createdAt: '2026-01-01T00:00:00.000Z',
};

export const T0 = '2026-01-15T10:00:00.000Z';

export function makeSession(over: Partial<Session> = {}): Session {
  return {
    sid: 'sess-aaaa-1111',
    pid: 4242,
    procStart: 'Thu Jan 15 09:00:00 2026',
    account: 2,
    configDir: '/synthetic/home/.claude-swap-backup/sessions/2-example',
    cwd: '/synthetic/home/projects/demo-app',
    folder: 'demo-app',
    name: 'refactor',
    entrypoint: 'cli',
    status: 'idle',
    statusSource: 'session-file',
    statusSince: T0,
    subagentsRunning: 0,
    tty: '/dev/ttys004',
    ...over,
  };
}

export function makeCard(over: Partial<PendingRequest> = {}): PendingRequest {
  const sid = over.sid ?? 'sess-aaaa-1111';
  return {
    id: newSecretId(),
    sid,
    kind: 'permission',
    tool: 'Bash',
    input: { command: 'npm test' },
    suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'session' }],
    correlationKey: `${sid}|Bash|{"command":"npm test"}`,
    createdAt: T0,
    settleUntil: '2026-01-15T10:00:03.000Z',
    state: 'open',
    ...over,
  };
}

// ---------------------------------------------------------------------------

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

export class FakeTranscripts implements TranscriptReader {
  items: TranscriptItem[] = [
    { id: 'u2', at: '2026-01-15T10:00:05.000Z', role: 'assistant', kind: 'text', text: 'All tests pass.' },
    { id: 'u1', at: '2026-01-15T10:00:01.000Z', role: 'user', kind: 'text', text: 'run the tests' },
  ];
  fail = false;
  async pathFor() {
    return null;
  }
  async size() {
    return 0;
  }
  async readFrom() {
    return { entries: [], next: 0 };
  }
  async tail() {
    return {};
  }
  async page(_sid: string, opts: { before?: string; limit: number }) {
    if (this.fail) throw new Error('disk on fire');
    return { items: this.items.slice(0, opts.limit), nextBefore: null };
  }
}

export class FakeUsage implements UsageSource {
  refreshes: string[] = [];
  async start() {}
  async stop() {}
  async read() {
    return null;
  }
  latest() {
    return null;
  }
  requestRefresh(reason: string) {
    this.refreshes.push(reason);
    return { queued: true, nextAllowedAt: '2026-01-15T10:02:00.000Z' };
  }
  isPolling() {
    return false;
  }
}

export class FakeCcwLegacy implements CcwLegacySource {
  isPresent = false;
  /** The ceiling ccw's switch.json would give (undefined: the plan names none). */
  planCeiling: number | undefined = undefined;
  burnRows: CcwBurn[] = [{ sid: 'sess-aaaa-1111', pctPerMin: 0.8, updatedAt: T0 }];
  async start() {}
  async stop() {}
  present() {
    return this.isPresent;
  }
  async botRunning() {
    return this.isPresent;
  }
  async moves() {
    return [];
  }
  async moveFor() {
    return null;
  }
  async moveLocked() {
    return false;
  }
  async burn() {
    return this.burnRows;
  }
  async plan(): Promise<PlanResponse> {
    return {
      source: 'ccw-legacy',
      next: 3,
      accounts: [{ id: 3, burnPctPerMin: 0.5, fullInMin: 120, ridesReset: true, usable: true }],
      updatedAt: T0,
      ...(this.planCeiling !== undefined ? { ceiling: this.planCeiling } : {}),
    };
  }
  async switchConfig() {
    return null;
  }
}

export class FakeHooks implements HooksBridge {
  readonly socketPath = '/synthetic/run/hooks.sock';
  decisions: { id: string; decision: DecisionBody; actor: string }[] = [];
  constructor(private readonly ctx: TestContext) {}
  async start() {}
  async stop() {}
  open() {
    return Object.values(this.ctx.store.getState().pending).filter((p) => p.state === 'open');
  }
  get(id: string) {
    return this.ctx.store.getState().pending[id];
  }
  async decide(id: string, decision: DecisionBody, actor: Actor): Promise<DecideResult> {
    const p = this.ctx.store.getState().pending[id];
    if (!p) return { ok: false, code: 'not_found', message: 'no such card' };
    if (p.state !== 'open') return { ok: false, code: 'conflict', message: 'card is not open' };
    if (p.tool === 'Bash' && decision.suggestion !== undefined && !decision.confirm) {
      return { ok: false, code: 'needs_confirm', message: 'confirm always-allow for Bash' };
    }
    this.decisions.push({ id, decision, actor: actorId(actor) });
    this.ctx.store.emit({ type: 'pending.resolved', sid: p.sid, data: { id, state: 'decided', decidedBy: actorId(actor), decision } });
    return { ok: true, pending: this.ctx.store.getState().pending[id] as PendingRequest };
  }
  onHookEvent() {
    return () => {};
  }
  hasHooks(sid: string) {
    return sid === 'sess-aaaa-1111';
  }
}

export class FakeTerminal implements TerminalBackend {
  readonly kind = 'terminal-app' as const;
  calls: string[] = [];
  screen = 'line 1\nline 2\n> ';
  readResult: OpResult<{ text: string; at: string }> | null = null;
  async available() {
    return true;
  }
  async findPane(target: PaneTarget): Promise<Pane | null> {
    this.calls.push(`findPane:${target.tty ?? '-'}`);
    if (!target.tty) return null;
    return { id: `ta:${target.tty}`, backend: 'terminal-app', handle: '1:1', tty: target.tty, foreground: 'claude' };
  }
  async readScreen(_pane: Pane, opts?: { lines?: number }) {
    this.calls.push(`readScreen:${opts?.lines ?? '-'}`);
    return this.readResult ?? { ok: true as const, text: this.screen, at: T0 };
  }
  async readInputBox() {
    return { ok: true as const, text: '', styled: false };
  }
  async type() {
    return { ok: true as const };
  }
  async pressEnter() {
    return { ok: true as const };
  }
  async focus(pane: Pane) {
    this.calls.push(`focus:${pane.id}`);
    return { ok: true as const };
  }
  async foregroundOf() {
    return 'claude' as const;
  }
}

export class FakeWriter implements Writer {
  jobs = new Map<string, SendJob>();
  submits: SubmitRequest[] = [];
  constructor(private readonly ctx: TestContext) {}
  async start() {}
  async stop() {}
  async submit(req: SubmitRequest): Promise<SubmitResult> {
    this.submits.push(req);
    if (!this.ctx.store.getState().sessions[req.sid]) return { ok: false, code: 'not_found', reason: 'no such session' };
    if (req.text === 'refuse-me') return { ok: false, code: 'refused', reason: 'a card is open for this session' };
    if (req.idempotencyKey) {
      for (const j of this.jobs.values()) if (j.idempotencyKey === req.idempotencyKey) return { ok: true, job: j, duplicate: true };
    }
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
    this.ctx.store.emit({ type: 'send.progress', sid: req.sid, data: { job } });
    return { ok: true, job, duplicate: false };
  }
  get(id: string) {
    return this.jobs.get(id);
  }
  async wait(id: string) {
    return this.jobs.get(id);
  }
  withPaneLock<T>(_pane: Pane, task: () => Promise<T>): Promise<T> {
    return task();
  }
}

export interface Fakes {
  sessions: FakeSessions;
  transcripts: FakeTranscripts;
  transcriptWatcher: TranscriptWatcher;
  usage: FakeUsage;
  ccwLegacy: FakeCcwLegacy;
  hooks: FakeHooks;
  terminal: FakeTerminal;
  writer: FakeWriter;
  notifiers: Notifier[];
  push: WebPushNotifier;
  pushed: { endpoint: string; payload: string; options: unknown }[];
  /** v0.3 and v0.4 parts: inert (501) unless a test passes its own through makeApi({ deps }). */
  v03: NotBuiltParts;
}

export function makeFakes(ctx: TestContext, sender?: PushSender): Fakes {
  const pushed: Fakes['pushed'] = [];
  const push = new WebPushNotifier(ctx, {
    vapid: TEST_VAPID,
    sender:
      sender ??
      (async (sub, payload, options) => {
        pushed.push({ endpoint: sub.endpoint, payload, options });
      }),
  });
  return {
    sessions: new FakeSessions(),
    transcripts: new FakeTranscripts(),
    transcriptWatcher: { start: async () => {}, stop: async () => {} },
    usage: new FakeUsage(),
    ccwLegacy: new FakeCcwLegacy(),
    hooks: new FakeHooks(ctx),
    terminal: new FakeTerminal(),
    writer: new FakeWriter(ctx),
    notifiers: [push],
    push,
    pushed,
    v03: notBuiltParts(),
  };
}

export function depsOf(f: Fakes): ApiDeps {
  return {
    sessions: f.sessions,
    transcripts: f.transcripts,
    transcriptWatcher: f.transcriptWatcher,
    usage: f.usage,
    ccwLegacy: f.ccwLegacy,
    hooks: f.hooks,
    terminal: f.terminal,
    writer: f.writer,
    notifiers: f.notifiers,
    ...f.v03,
  };
}

// ---------------------------------------------------------------------------

export interface TestApi {
  ctx: TestContext;
  fakes: Fakes;
  services: ApiServices;
  tcp: Awaited<ReturnType<typeof buildApp>>;
  ctl: Awaited<ReturnType<typeof buildApp>>;
  close(): Promise<void>;
}

export async function makeApi(
  opts: {
    ctx?: TestContextOptions;
    api?: ApiOptions;
    sessions?: Session[];
    /** Replace any dependency, e.g. `{ rewrite: myRewrite }` (built on the test context). */
    deps?: (ctx: TestContext, fakes: Fakes) => Partial<ApiDeps>;
  } = {},
): Promise<TestApi> {
  const ctx = createTestContext(opts.ctx);
  const fakes = makeFakes(ctx);
  const services = new ApiServices(ctx, { ...depsOf(fakes), ...opts.deps?.(ctx, fakes) }, { port: PORT, webDist: null, ...opts.api });
  for (const s of opts.sessions ?? [makeSession()]) ctx.store.emit({ type: 'session.added', sid: s.sid, data: { session: s } });
  const tcp = await buildApp(services, 'tcp');
  const ctl = await buildApp(services, 'ctl');
  return {
    ctx,
    fakes,
    services,
    tcp,
    ctl,
    async close() {
      await tcp.close();
      await ctl.close();
    },
  };
}

/**
 * The device secret each paired test cookie came with (SEC-2). `h(cookie)`
 * adds it, like the web app does; `bare(cookie)` sends the cookie alone,
 * like someone replaying a cookie read on another 127.0.0.1 port.
 */
const SECRETS = new Map<string, string>();

/** Pair a device through the real pairing flow and return its cookie header value and device secret. */
export async function pairCookie(
  api: TestApi,
  scopes: Scope[] = ['read', 'control'],
  name = 'Test phone',
): Promise<{ cookie: string; deviceId: string; secret: string }> {
  const start = await api.ctl.inject({ method: 'POST', url: '/v1/pair/start', payload: { scopes } });
  if (start.statusCode !== 200) throw new Error(`pair start failed: ${start.body}`);
  const code = (start.json() as { code: string }).code;
  const claim = await api.tcp.inject({
    method: 'POST',
    url: '/v1/pair/claim',
    headers: { host: HOST, origin: ORIGIN },
    payload: { code, name },
  });
  if (claim.statusCode !== 200) throw new Error(`pair claim failed: ${claim.body}`);
  const set = claim.cookies.find((c) => c.name === DEVICE_COOKIE);
  if (!set) throw new Error('no device cookie');
  const body = claim.json() as { device: { id: string }; deviceSecret?: string };
  if (!body.deviceSecret) throw new Error('no device secret in the claim reply');
  const cookie = `${DEVICE_COOKIE}=${set.value}`;
  SECRETS.set(cookie, body.deviceSecret);
  return { cookie, deviceId: body.device.id, secret: body.deviceSecret };
}

/** Headers a paired browser sends: Host, Origin, its cookie and (when known) its device secret. */
export function h(cookie?: string, extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = { host: HOST, origin: ORIGIN, ...extra };
  if (cookie) {
    out.cookie = cookie;
    const secret = SECRETS.get(cookie);
    if (secret && !(DEVICE_SECRET_HEADER in extra)) out[DEVICE_SECRET_HEADER] = secret;
  }
  return out;
}

/** Host, Origin and the cookie only: no device secret. */
export function bare(cookie?: string, extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = { host: HOST, origin: ORIGIN, ...extra };
  if (cookie) out.cookie = cookie;
  return out;
}
