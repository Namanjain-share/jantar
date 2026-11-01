/**
 * v0.6.1 end to end: jantard in-process on a synthetic HOME, driven over its
 * real sockets (hooks, the control socket, a paired phone's event stream).
 *
 * 1. A turn launches a dynamic workflow and a background shell, Claude
 *    writes its turn_duration count, and the Stop hook ends the turn.
 * 2. The session's status is the turn's (idle, from the hook), and
 *    `background` says a workflow and a shell run; `jantar status` marks it
 *    working and says what runs.
 * 3. A notification for a task the main chain never launched changes
 *    nothing; the workflow's own ends it, leaving the quiet shell count, and
 *    `jantar status` says Done with "[1 shell]".
 * 4. A relaunch (a new process start in the session file) clears it.
 * 5. Marker words in the workflow's summary, the shell's command, an
 *    agent's description and a notification's summary reach no state, no
 *    event and no CLI output.
 *
 * Every id, folder, name and word is made up.
 */
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_LIVE_SIDS,
  assistantToolUse,
  perfBudgetMs,
  queueOperation,
  shellLaunched,
  taskNotification,
  toolResultWith,
  turnDuration,
  workflowLaunched,
  type EntryContext,
} from '@jantar/fixtures';
import { DEVICE_COOKIE, eventsSocketProtocols, type PairStartResponse, type SessionsResponse, type StateResponse } from '@jantar/protocol';
import { callDaemon, createCtlClient, main, memoryIo, type CtlClient } from '../../packages/cli/src/index.js';
import { bootDaemon, type Daemon } from './harness.js';
import { cookieFrom, eventually, hookTag, http, rememberSecret, sendHook } from './http.js';

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

const SID = DEFAULT_LIVE_SIDS[0]!;
const MARK = 'WOMBATMARKER';
const W1 = 'wdemoaaaa';
const B1 = 'bdemobbbb';

describe('v0.6.1: background work end to end', () => {
  let d: Daemon;
  let ctl: CtlClient;
  let ws: WsClient | undefined;
  const frames: string[] = [];
  const outputs: string[] = [];
  let launchedAt = '';

  const state = async () => (await callDaemon<StateResponse>(ctl, 'GET', '/v1/state')).state;
  const live = async () => (await state()).sessions[SID];
  const ctx = (offsetMs = 0): EntryContext => {
    const s = d.home.session(SID);
    return { sessionId: SID, cwd: s.cwd, at: new Date(Date.now() + offsetMs).toISOString() };
  };
  const hook = async (event: 'UserPromptSubmit' | 'Stop', extra: Record<string, unknown>) => {
    const s = d.home.session(SID);
    await sendHook(
      d.ctx.paths.hooksSock,
      { hook_event_name: event, session_id: SID, transcript_path: s.transcriptPath, cwd: s.cwd, ...extra, _jantar: hookTag(s.pid, false, s.configDir) },
      false,
    ).reply;
  };
  const status = async () => {
    const io = memoryIo(d.home.env);
    expect(await main(['status'], { io, context: { paths: d.ctx.paths, ctl } }), io.stderr).toBe(0);
    outputs.push(io.stdout);
    return io.stdout;
  };
  /** The `background` patches the phone's event stream carried for the session, in order. */
  const patches = () =>
    frames
      .map((f) => JSON.parse(f) as { kind?: string; event?: { type?: string; sid?: string; data?: { patch?: Record<string, unknown> } } })
      .filter((m) => m.kind === 'event' && m.event?.type === 'session.updated' && m.event.sid === SID && m.event.data?.patch && 'background' in m.event.data.patch)
      .map((m) => m.event?.data?.patch?.background);

  beforeAll(async () => {
    d = await bootDaemon();
    ctl = createCtlClient(d.ctx.paths.ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket');
    await eventually(async () => (await callDaemon<SessionsResponse>(ctl, 'GET', '/v1/sessions')).sessions.some((s) => s.sid === SID), 15_000, 'the live session');
    const start = await callDaemon<PairStartResponse>(ctl, 'POST', '/v1/pair/start', { name: 'background phone', scopes: ['read'] });
    const claim = await http(d.port, 'POST', '/v1/pair/claim', { body: { code: start.code, name: 'background phone' } });
    expect(claim.status, claim.text).toBe(200);
    const phone = cookieFrom(claim, DEVICE_COOKIE) as string;
    rememberSecret(phone, claim.body);
    const secret = (claim.body as { deviceSecret: string }).deviceSecret;
    const socket = new WebSocket(`ws://127.0.0.1:${d.port}/v1/events`, eventsSocketProtocols(secret), {
      headers: { origin: `http://127.0.0.1:${d.port}`, cookie: phone },
    });
    ws = socket;
    socket.on('message', (data) => frames.push(String(data)));
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.on('error', reject);
    });
  }, perfBudgetMs(60_000));

  afterAll(async () => {
    ws?.close();
    await d?.stop();
  }, perfBudgetMs(30_000));

  it('1-2. a workflow launched in a turn keeps the session working after its Stop', async () => {
    await hook('UserPromptSubmit', { prompt: 'sweep the demo folders' });
    const launch = toolResultWith(ctx(1), 'toolu_demo_w', `Workflow launched in background. Task ID: ${W1}`, {
      ...workflowLaunched(W1, 'demo-sweep'),
      summary: `${MARK} workflow summary`,
    });
    launchedAt = String(launch.timestamp);
    await d.home.appendTranscript(SID, [
      assistantToolUse(ctx(0), 'Workflow', { script: 'synthetic' }, 'toolu_demo_w'),
      launch,
      assistantToolUse(ctx(2), 'Bash', { command: 'synthetic watch', run_in_background: true }, 'toolu_demo_b'),
      toolResultWith(ctx(3), 'toolu_demo_b', `Command running in background with ID: ${B1}`, { ...shellLaunched(B1), command: `${MARK} command` }),
      toolResultWith(ctx(4), 'toolu_demo_a', 'Async agent launched successfully.', { status: 'async_launched', agentId: 'a0123456789abcdef', description: `${MARK} description`, prompt: `${MARK} prompt` }, true),
      turnDuration(ctx(5), { workflows: 1 }),
    ]);
    await hook('Stop', { last_assistant_message: 'Started the sweep in the background.', stop_hook_active: false });

    const s = await eventually(async () => {
      const x = await live();
      return x?.status === 'idle' && x.background?.workflows === 1 && x.background.shells === 1 ? x : null;
    }, 15_000, 'idle with the workflow running');
    expect(s.statusSource).toBe('hook');
    expect(s.background).toEqual({ workflows: 1, shells: 1, since: launchedAt, names: ['demo-sweep'] });

    const out = await status();
    expect(out).toContain(`  * Working · alpha-app · `);
    expect(out).toContain('1 workflow running · demo-sweep · ');
    expect(out).toContain(' · 1 shell');
  }, perfBudgetMs(60_000));

  it("3. a stranger's notification changes nothing; the workflow's own ends it, leaving the quiet shell", async () => {
    await d.home.appendTranscript(SID, [queueOperation(ctx(), 'enqueue', taskNotification('bdemozzzz', 'completed', `${MARK} stranger summary`))]);
    await new Promise((r) => setTimeout(r, 1500)); // a poll or more: nothing to publish
    expect((await live())?.background).toMatchObject({ workflows: 1, shells: 1 });

    await d.home.appendTranscript(SID, [queueOperation(ctx(), 'enqueue', taskNotification(W1, 'completed', `${MARK} workflow done`))]);
    const s = await eventually(async () => {
      const x = await live();
      return x?.background && x.background.workflows === undefined ? x : null;
    }, 15_000, 'the workflow to end');
    expect(s.background).toEqual({ shells: 1 });
    expect(s.status).toBe('idle');

    const out = await status();
    expect(out).toContain(`  > Done · alpha-app · `);
    expect(out).toContain('  [1 shell]');
    expect(out).not.toContain('workflow running');
    // the phone saw exactly two changes: the stranger's notification made none
    await eventually(async () => (patches().length >= 2 ? true : null), 10_000, 'the two background events');
    expect(patches()).toEqual([{ workflows: 1, shells: 1, since: launchedAt, names: ['demo-sweep'] }, { shells: 1 }]);
  }, perfBudgetMs(60_000));

  it('4. a relaunch clears it', async () => {
    await d.home.updateSessionFile(SID, { startedAt: Date.now() + 1000 });
    const s = await eventually(async () => {
      const x = await live();
      return x?.background && Object.keys(x.background).length === 0 ? x : null;
    }, 15_000, 'the field to clear');
    expect(s.background).toEqual({});
    await eventually(async () => (patches().length >= 3 ? true : null), 10_000, 'the clearing event');
    expect(patches().at(-1)).toEqual({});
  }, perfBudgetMs(60_000));

  it('5. no marker reaches the state, the event stream or the CLI', async () => {
    const st = JSON.stringify(await state());
    expect(frames.length).toBeGreaterThan(0);
    expect(outputs.join('\n')).toContain('demo-sweep'); // what may show did
    for (const [where, text] of [
      ['state', st],
      ['events', frames.join('\n')],
      ['cli', outputs.join('\n')],
    ] as const) {
      expect(text, where).not.toContain(MARK);
      for (const id of [W1, B1, 'a0123456789abcdef', 'bdemozzzz']) expect(text, `${where}: ${id}`).not.toContain(id);
    }
  });
});
