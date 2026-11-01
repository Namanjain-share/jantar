/**
 * Single-account mode end to end (v0.4 spec 4.11, O5) and Resume (9.3 flow
 * 8): jantard in-process on a synthetic HOME with one Claude login, no
 * cswap binary and no profiles. `claude` (the fake) is the only Claude on
 * the Mac.
 *
 * 1. The daemon finds single mode by itself: one account 0, the live
 *    session on it, and cswap never run.
 * 2. Life works on it, and Ask Claude runs `claude -p` itself on account 0.
 * 3. Resume: a folder's past conversations listed newest first with their
 *    first lines masked; `jantar new <folder> --resume last` types
 *    `cd -- <folder> && <claude> ... --resume <newest id>` with no
 *    --session-id into a new window, the session comes up under that id on
 *    account 0, and a second start of the same conversation is 409.
 * 4. A past conversation's first line (LIFE_MARKER, an e-mail address and a
 *    key-shaped token) reaches no WS frame, event, audit row, log line or
 *    launch row; only the history reply carries it, masked.
 */
import { mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LAUNCH_TTY,
  LAUNCH_WINDOW_ID,
  LIFE_MARKER,
  LaunchScreenScript,
  PAST_SECRET_EMAIL,
  PAST_SECRET_TOKEN,
  claudeCalls,
  completeLaunch,
  estimateText,
  launchAccounts,
  markersIn,
  parseLaunchCommand,
  perfBudgetMs,
  todoBody,
  writePastSessions,
  type FakeHome,
  type PastSessionSpec,
} from '@jantar/fixtures';
import type { OpResult, PaneTarget } from '@jantar/daemon';
import {
  DEFAULT_LAUNCH_FLAGS,
  DEVICE_COOKIE,
  eventsSocketProtocols,
  type AccountsResponse,
  type FoodEstimate,
  type LaunchHistoryResponse,
  type PairStartResponse,
  type Pane,
  type PaneForeground,
  type SessionsResponse,
  type StateResponse,
} from '@jantar/protocol';
import { callDaemon, createCtlClient, defaultDeps, main, memoryIo, type CtlClient } from '../../packages/cli/src/index.js';
import { bootDaemon, fakeBinsSettings, type Daemon } from './harness.js';
import { cookieFrom, eventually, http, rememberSecret, type HttpResult } from './http.js';
import { ScriptedTerminal } from './scripted-terminal.js';

const daemonRequire = createRequire(new URL('../../packages/daemon/package.json', import.meta.url));
interface WsClient {
  on(ev: 'message', fn: (data: unknown) => void): void;
  on(ev: 'error', fn: (e: Error) => void): void;
  once(ev: 'open', fn: () => void): void;
  close(): void;
}
const WebSocket = createRequire(daemonRequire.resolve('@fastify/websocket'))('ws') as new (
  url: string,
  protocols: string[],
  opts: { headers: Record<string, string> },
) => WsClient;

const SID = '81818181-8181-4818-8818-818181818181';
const norm = (tty: string | undefined) => (tty ?? '').replace(/^\/dev\//, '');
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
/** Three conversations in the folder, newest first; the newest carries the marker, the oldest an address and a token. */
const PAST: readonly PastSessionSpec[] = [
  { id: '0b4e7c4e-aaaa-4aaa-8aaa-00000000000a', first: `fix the example header ${LIFE_MARKER}`, at: ago(30) },
  { id: '0b4e7c4e-bbbb-4bbb-8bbb-00000000000b', first: 'write tests for the example form', at: ago(90) },
  { id: '0b4e7c4e-cccc-4ccc-8ccc-00000000000c', first: `mail ${PAST_SECRET_EMAIL} the key ${PAST_SECRET_TOKEN} please`, at: ago(240) },
];
const SECRETS = [LIFE_MARKER, PAST_SECRET_EMAIL, PAST_SECRET_TOKEN];

/** The harness's terminal plus a new window that plays the "clean" flow and, once ready, writes the session file. */
class ResumeTerminal extends ScriptedTerminal {
  readonly opened: string[] = [];
  launch: LaunchScreenScript | null = null;
  private launched = false;

  constructor(private readonly fake: FakeHome) {
    super(fake);
  }

  private isLaunchTab(tty: string | undefined): boolean {
    return this.launch !== null && norm(tty) === norm(LAUNCH_TTY);
  }

  async openWindow(command: string): Promise<OpResult<{ tty: string; windowId: string }>> {
    this.opened.push(command);
    const { folder } = parseLaunchCommand(command);
    if (!folder) return { ok: false, code: 'failed', reason: 'no folder in the command' };
    this.launch = new LaunchScreenScript('clean', { folder, command });
    return { ok: true, tty: LAUNCH_TTY, windowId: String(LAUNCH_WINDOW_ID) };
  }

  override async findPane(target: PaneTarget): Promise<Pane | null> {
    if (this.isLaunchTab(target.tty)) {
      return { id: `terminal-app:${norm(LAUNCH_TTY)}`, backend: 'terminal-app', handle: '9:1', tty: norm(LAUNCH_TTY), foreground: 'claude', title: 'claude' };
    }
    return super.findPane(target);
  }

  override async readScreen(pane: Pane, opts: { lines?: number } = {}): Promise<OpResult<{ text: string; at: string }>> {
    if (!this.isLaunchTab(pane.tty) || !this.launch) return super.readScreen(pane, opts);
    const text = this.launch.screen();
    // Past the shell, Claude writes the session file under the resumed id (claude mode: the default login's).
    if (this.launch.state === 'ready' && !this.launched) {
      this.launched = true;
      await completeLaunch(this.fake, { command: this.opened.at(-1), startedAt: Date.now() });
    }
    return { ok: true, text, at: new Date().toISOString() };
  }

  override async foregroundOf(pane: Pane): Promise<PaneForeground> {
    if (!this.isLaunchTab(pane.tty) || !this.launch) return super.foregroundOf(pane);
    return this.launch.state === 'shell' || this.launch.state === 'claudeExited' ? 'shell' : 'claude';
  }
}

describe('single-account mode with no cswap, and Resume Last', () => {
  let d: Daemon;
  let terminal: ResumeTerminal;
  let ctl: CtlClient;
  let phone: string;
  let ws: WsClient;
  let folder = '';
  const frames: string[] = [];
  const writes: Array<{ what: string; text: string }> = [];

  const dumpLog = () =>
    d?.log.records
      .filter((r) => r.level === 'warn' || r.level === 'error')
      .slice(-20)
      .map((r) => `${r.level} ${r.msg} ${JSON.stringify(r.fields)}`)
      .join('\n');

  async function call(method: string, path: string, body?: unknown): Promise<HttpResult> {
    // Every write keeps one key, as the web does; Ask Claude goes without one (LP3: never cached).
    const keyed = method !== 'GET' && path !== '/v1/food/estimate';
    const headers: Record<string, string> = keyed ? { 'idempotency-key': `k-${Math.random().toString(36).slice(2)}` } : {};
    const r = await http(d.port, method, path, { cookie: phone, headers, ...(body === undefined ? {} : { body }) });
    if (method !== 'GET') writes.push({ what: `${method} ${path}`, text: r.text });
    return r;
  }

  async function get<T>(path: string): Promise<T> {
    const r = await call('GET', path);
    expect(r.status, `GET ${path}: ${r.text}\n${dumpLog()}`).toBe(200);
    return r.body as T;
  }

  async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
    const io = memoryIo(d.home.env);
    const code = await main(argv, { io, context: { paths: d.ctx.paths, ctl, deps: defaultDeps(d.home.env) } });
    return { code, out: io.stdout, err: io.stderr };
  }

  beforeAll(async () => {
    d = await bootDaemon({
      // One login: account 1 is the fake home's default (~/.claude), with no profile.
      home: {
        accounts: launchAccounts().filter((a) => a.profile === null),
        sessions: [{ sid: SID, pid: 81001, account: 1, project: 'demo-app', status: 'idle', tty: 'ttys081', transcript: [] }],
      },
      // No cswap on this Mac: its binary and its profiles are gone before the daemon starts.
      before: async (home) => {
        await rm(home.bins.cswap, { force: true });
        await rm(home.paths.cswapRoot, { recursive: true, force: true });
      },
      settings: (home) => ({
        bins: { ...fakeBinsSettings(home), cswap: join(home.root, 'not-installed', 'cswap'), claude: home.bins.claude },
        launch: { enabled: true, mode: 'claude' },
      }),
      terminal: (home) => (terminal = new ResumeTerminal(home)),
    });
    ctl = createCtlClient(d.ctx.paths.ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket');
    await eventually(async () => (await callDaemon<SessionsResponse>(ctl, 'GET', '/v1/sessions')).sessions.some((s) => s.sid === SID), 15_000, 'the live session');
    const start = await callDaemon<PairStartResponse>(ctl, 'POST', '/v1/pair/start', { name: 'single phone', scopes: ['read', 'control', 'launch'] });
    const claim = await http(d.port, 'POST', '/v1/pair/claim', { body: { code: start.code, name: 'single phone' } });
    expect(claim.status, claim.text).toBe(200);
    phone = cookieFrom(claim, DEVICE_COOKIE) as string;
    rememberSecret(phone, claim.body);
    const secret = (claim.body as { deviceSecret: string }).deviceSecret;
    ws = new WebSocket(`ws://127.0.0.1:${d.port}/v1/events`, eventsSocketProtocols(secret), { headers: { origin: `http://127.0.0.1:${d.port}`, cookie: phone } });
    ws.on('message', (data) => frames.push(String(data)));
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.on('error', reject);
    });
  }, perfBudgetMs(60_000));

  afterAll(async () => {
    ws?.close();
    await d?.stop();
  }, perfBudgetMs(30_000));

  it('1. finds single mode by itself: one account 0, the live session on it, cswap never run', async () => {
    expect(d.ctx.accountsMode()).toBe('single');
    expect(d.ctx.bins.cswap).toBeNull();
    const state = await get<StateResponse>('/v1/state');
    expect(state.state.daemon?.accountsMode).toBe('single');
    const accounts = await get<AccountsResponse>('/v1/accounts');
    expect(accounts.accounts.map((a) => a.id)).toEqual([0]);
    const sessions = await get<SessionsResponse>('/v1/sessions');
    expect(sessions.sessions.find((s) => s.sid === SID)?.account).toBe(0);
    expect(await d.home.calls('cswap')).toEqual([]);
  });

  it('2. Life works, and Ask Claude runs claude -p itself on account 0', async () => {
    const on = await cli('life', 'on', 'todos', 'food');
    expect(on.code, on.err).toBe(0);
    const todo = await call('POST', '/v1/todos', todoBody());
    expect(todo.status, todo.text).toBe(200);
    expect((await get<{ todos: unknown[] }>('/v1/todos')).todos).toHaveLength(1);

    const r = await call('POST', '/v1/food/estimate', { text: estimateText() });
    expect(r.status, `${r.text}\n${dumpLog()}`).toBe(200);
    expect((r.body as FoodEstimate).items.map((i) => i.name)).toEqual(['Roti', 'Dal']);
    const [run] = await claudeCalls(d.home);
    expect(run).toMatchObject({ via: 'claude', account: null });
    expect(run?.args[0]).toBe('-p');
    expect(Object.keys(run?.env ?? {})).not.toContain('CLAUDE_CONFIG_DIR');
    const audit = d.ctx.db.audit.list().find((a) => a.action === 'food.estimate');
    expect(audit?.params).toMatchObject({ account: 0, ok: true });
    expect(await d.home.calls('cswap')).toEqual([]);
  }, perfBudgetMs(60_000));

  it('3. Resume Last: the history newest first and masked, then --resume <newest id> typed in claude mode, ready on account 0', async () => {
    folder = join(d.home.home, 'Desktop', 'work', 'foo');
    await mkdir(folder, { recursive: true });
    await writePastSessions(d.home, folder, PAST);
    const root = await cli('folders', 'add-root', join(d.home.home, 'Desktop', 'work'), '--id', 'work');
    expect(root.code, root.err).toBe(0);

    const history = await get<LaunchHistoryResponse>('/v1/launch/history?root=r.work&path=foo');
    expect(history.sessions.map((s) => s.id)).toEqual(PAST.map((p) => p.id));
    const firsts = history.sessions.map((s) => s.first ?? '');
    expect(firsts[0]).toContain(LIFE_MARKER);
    expect(firsts.join('\n')).not.toContain(PAST_SECRET_EMAIL);
    expect(firsts.join('\n')).not.toContain(PAST_SECRET_TOKEN);

    const started = await cli('new', folder, '--resume', 'last', '--timeout', '60');
    expect(started.code, `${started.out}\n${started.err}\n${dumpLog()}`).toBe(0);
    const [command] = terminal.opened;
    const parsed = parseLaunchCommand(command as string);
    expect(parsed).toMatchObject({ mode: 'claude', folder, account: null, resume: PAST[0]?.id, sessionId: null });
    expect(command).toContain(`&& ${d.home.bins.claude}`);
    expect(command).not.toContain('--session-id');
    expect(command).not.toContain('cswap');
    const sessions = await get<SessionsResponse>('/v1/sessions');
    expect(sessions.sessions.find((s) => s.sid === PAST[0]?.id)).toMatchObject({ cwd: folder, account: 0 });
    const launch = d.ctx.db.audit.list().find((a) => a.action === 'session.launch');
    expect(launch?.params).toMatchObject({ sid: PAST[0]?.id, resumed: true });

    // That conversation is open now: starting it again is refused.
    const again = await call('POST', '/v1/launches', { root: 'r.work', path: 'foo', account: 'auto', flags: DEFAULT_LAUNCH_FLAGS, resume: PAST[0]?.id });
    expect(again.status, again.text).toBe(409);
  }, perfBudgetMs(90_000));

  it("4. a past conversation's first line reaches no frame, event, audit row, log line, launch row or write reply", async () => {
    const replay = d.ctx.store.replay(0);
    const sources: Record<string, unknown> = {
      'WS frames': frames.map((f) => JSON.parse(f) as unknown),
      'event ring': replay.kind === 'events' ? replay.events : [],
      'stored events': d.ctx.db.events.since(0),
      'audit rows': d.ctx.db.audit.list({ after: 0, limit: 100_000 }),
      'log lines': d.log.records,
      'launch rows': d.ctx.db.launches.list({ limit: 1000 }),
      'write replies': writes,
    };
    for (const [what, value] of Object.entries(sources)) expect(markersIn(value, SECRETS), what).toEqual([]);
    expect(frames.length).toBeGreaterThan(5);
  });
});
