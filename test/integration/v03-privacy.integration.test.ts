/**
 * The v0.3 privacy sweep (spec rules G7, A1, A2) through jantard end to end:
 * the daemon booted with the production wiring on a synthetic HOME, every
 * v0.3 switch on but screenshots, a phone paired with read, control and
 * launch, and its event stream (WS /v1/events) open from the start.
 *
 * Markers are planted in every kind of text the daemon must keep to itself:
 * the dictated text of a Rewrite (REWRITE_MARKER, also in the prompt it
 * writes and sends), a file's content and a session's Write and Edit of it
 * (FILE_MARKER), the Terminal screen of the live session and of a launch
 * window (SCREEN_MARKER), and a secret (SECRET_MARKER). Then every v0.3 path
 * runs: Rewrite (start, read, send with the job, a cancel), Files (roots,
 * list, text, the secret refused), changed files, the text peek and the mode
 * it publishes, a mode switch and a key, and a launch through the trust card.
 *
 * Afterwards no marker is in a WS frame, the event ring, the stored events,
 * an audit row, a log line, a push, a launch row or any write reply. A read
 * reply may carry what it was asked for (rewriteGet the prompt, files/text
 * the file, the peek the screen), and those are checked to have, so the
 * markers were really in play. The secret is in no reply at all.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LAUNCH_HELD,
  DICTATED,
  FILE_MARKER,
  LAUNCH_TTY,
  LAUNCH_WINDOW_ID,
  LaunchScreenScript,
  PRIVACY_MARKERS,
  REWRITE_MARKER,
  SCREEN_MARKER,
  SECRET_MARKER,
  assistantToolUse,
  completeLaunch,
  fileToolResult,
  launchAccounts,
  markersIn,
  parseLaunchCommand,
  perfBudgetMs,
  type FakeHome,
} from '@jantar/fixtures';
import type { OpResult, PaneTarget, PressKeyOptions } from '@jantar/daemon';
import {
  DEVICE_COOKIE,
  eventsSocketProtocols,
  type ControlKey,
  type LaunchFlags,
  type LaunchJob,
  type Pane,
  type PaneForeground,
  type PairStartResponse,
  type RewriteDetail,
  type RewriteJob,
  type SessionChangesResponse,
  type SessionsResponse,
} from '@jantar/protocol';
import { callDaemon, createCtlClient } from '../../packages/cli/src/index.js';
import { bootDaemon, type Daemon } from './harness.js';
import { cookieFrom, eventually, http, rememberSecret, type HttpResult } from './http.js';
import { ScriptedTerminal } from './scripted-terminal.js';

// The `ws` client @fastify/websocket itself depends on (the daemon's own dependency; test only).
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

const SID = '53535353-5353-4535-8535-535353535353';
const MODE_LINES = {
  default: '  ⏸ manual mode on (shift+tab to cycle)',
  acceptEdits: '  ⏵⏵ accept edits on (shift+tab to cycle)',
  plan: '  ⏸ plan mode on (shift+tab to cycle)',
} as const;
const CYCLE = ['default', 'acceptEdits', 'plan'] as const;
const norm = (tty: string | undefined) => (tty ?? '').replace(/^\/dev\//, '');

/**
 * The harness's scripted session with screen text of its own above the input
 * box and Claude's mode line under it (Shift+Tab cycles it, from the phone or
 * "at the Mac" through `macShiftTab`), plus a new window that plays WP-T1's
 * LaunchScreenScript (its top line carries SCREEN_MARKER).
 */
class PrivacyTerminal extends ScriptedTerminal {
  readonly keys: Array<{ tty: string; key: ControlKey }> = [];
  readonly opened: string[] = [];
  launch: LaunchScreenScript | null = null;
  private mode = 0;
  private launched = false;

  constructor(private readonly fake: FakeHome) {
    super(fake);
    this.scrollback = `⏺ Done. All synthetic tests pass.\n  ${SCREEN_MARKER}\n`;
  }

  /** A Shift+Tab pressed at the Mac: no hook fires, the screen changes. */
  macShiftTab(): void {
    this.mode = (this.mode + 1) % CYCLE.length;
  }

  override screenFor(pane: Pane): string {
    return super.screenFor(pane).replace('  ? for shortcuts', MODE_LINES[CYCLE[this.mode] ?? 'default']);
  }

  private isLaunchTab(tty: string | undefined): boolean {
    return this.launch !== null && norm(tty) === norm(LAUNCH_TTY);
  }

  async openWindow(command: string): Promise<OpResult<{ tty: string; windowId: string }>> {
    this.opened.push(command);
    const { folder } = parseLaunchCommand(command);
    if (!folder) return { ok: false, code: 'failed', reason: 'no folder in the command' };
    this.launch = new LaunchScreenScript('trust-then-chrome', { folder, command });
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
    return { ok: true, text: this.launch.screen(), at: new Date().toISOString() };
  }

  override async foregroundOf(pane: Pane): Promise<PaneForeground> {
    if (!this.isLaunchTab(pane.tty) || !this.launch) return super.foregroundOf(pane);
    return this.launch.state === 'shell' || this.launch.state === 'claudeExited' ? 'shell' : 'claude';
  }

  async pressKey(pane: Pane, key: ControlKey, opts: PressKeyOptions = {}): Promise<OpResult> {
    this.keys.push({ tty: norm(pane.tty), key });
    if (this.isLaunchTab(pane.tty) && this.launch) {
      if (key !== 'up' && key !== 'down' && key !== 'enter') return { ok: false, code: 'unsupported', reason: 'not a menu key' };
      this.launch.press(key, opts.repeat ?? 1);
      if (this.launch.state === 'ready' && !this.launched) {
        this.launched = true;
        await completeLaunch(this.fake, { command: this.opened.at(-1), startedAt: Date.now() });
      }
      return { ok: true };
    }
    if (key === 'shiftTab') this.macShiftTab();
    return { ok: true };
  }
}

/**
 * A session's `now` is the board's line for it since v0.1: the latest prompt
 * in its transcript, sent to every device. The prompt sent from the Rewrite
 * sheet becomes one once it is typed, like any prompt sent from the phone, so
 * that line (`{kind: 'prompt'}` with exactly that text) is left out of the
 * sweep. Anything else holding a marker still fails it: what was dictated, a
 * Rewrite job's own events, file content, screen text.
 */
function withoutSentPrompt(value: unknown, sent: string): unknown {
  if (Array.isArray(value)) return value.map((v) => withoutSentPrompt(v, sent));
  if (value === null || typeof value !== 'object') return value;
  const o = value as Record<string, unknown>;
  if (sent !== '' && o.kind === 'prompt' && o.text === sent) return { kind: 'prompt', text: '(the prompt sent from the Rewrite sheet)' };
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, withoutSentPrompt(v, sent)]));
}

describe('v0.3 privacy sweep: no dictated text, file content, screen text or secret leaves the daemon', () => {
  let d: Daemon;
  let terminal: PrivacyTerminal;
  let phone: string;
  let cwd: string;
  let ws: WsClient;
  /** The prompt sent from the Rewrite sheet (it carries REWRITE_MARKER). */
  let sentPrompt = '';
  /** Every WS frame, as sent. */
  const frames: string[] = [];
  /** Every reply to a write (POST, PATCH, DELETE): the idempotency cache keeps them. */
  const writes: Array<{ what: string; text: string }> = [];
  /** Every reply to a read. */
  const reads: Array<{ what: string; text: string }> = [];

  const dumpLog = () =>
    d?.log.records
      .filter((r) => r.level === 'warn' || r.level === 'error')
      .slice(-20)
      .map((r) => `${r.level} ${r.msg} ${JSON.stringify(r.fields)}`)
      .join('\n');

  async function call(method: string, path: string, body?: unknown, key?: string): Promise<HttpResult> {
    const headers: Record<string, string> = method === 'GET' ? {} : { 'idempotency-key': key ?? `k-${Math.random().toString(36).slice(2)}` };
    const r = await http(d.port, method, path, { cookie: phone, headers, ...(body === undefined ? {} : { body }) });
    (method === 'GET' ? reads : writes).push({ what: `${method} ${path}`, text: r.text });
    return r;
  }

  async function get<T>(path: string): Promise<T> {
    const r = await call('GET', path);
    expect(r.status, `GET ${path}: ${r.text}\n${dumpLog()}`).toBe(200);
    return r.body as T;
  }

  const eventTypes = () => frames.map((f) => JSON.parse(f) as { kind: string; event?: { type: string } }).flatMap((m) => (m.kind === 'event' && m.event ? [m.event.type] : []));

  beforeAll(async () => {
    d = await bootDaemon({
      home: {
        accounts: launchAccounts(),
        sessions: [{ sid: SID, pid: 53001, account: 5, project: 'demo-app', status: 'idle', tty: 'ttys053', transcript: [] }],
      },
      settings: {
        files: { enabled: true },
        rewrite: { enabled: true },
        launch: { enabled: true },
        controls: { enabled: true },
        autoswitch: { hold: [...LAUNCH_HELD] },
      },
      terminal: (home) => (terminal = new PrivacyTerminal(home)),
    });
    const ctl = createCtlClient(d.ctx.paths.ctlSock);
    await eventually(() => callDaemon(ctl, 'GET', '/healthz'), 10_000, 'the control socket');
    await eventually(async () => (await callDaemon<SessionsResponse>(ctl, 'GET', '/v1/sessions')).sessions.some((s) => s.sid === SID), 15_000, 'the live session');
    const start = await callDaemon<PairStartResponse>(ctl, 'POST', '/v1/pair/start', { name: 'privacy', scopes: ['read', 'control', 'launch'] });
    const claim = await http(d.port, 'POST', '/v1/pair/claim', { body: { code: start.code, name: 'privacy phone' } });
    expect(claim.status, claim.text).toBe(200);
    phone = cookieFrom(claim, DEVICE_COOKIE) as string;
    rememberSecret(phone, claim.body);
    cwd = d.home.session(SID).cwd;

    // The phone's event stream, open before anything happens.
    const secret = (claim.body as { deviceSecret: string }).deviceSecret;
    ws = new WebSocket(`ws://127.0.0.1:${d.port}/v1/events`, eventsSocketProtocols(secret), { headers: { origin: `http://127.0.0.1:${d.port}`, cookie: phone } });
    ws.on('message', (data) => frames.push(String(data)));
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.on('error', reject);
    });
    await eventually(async () => frames.some((f) => f.includes('"kind":"snapshot"')), 5_000, 'the snapshot');
  }, perfBudgetMs(60_000));

  afterAll(async () => {
    ws?.close();
    await d?.stop();
  }, perfBudgetMs(30_000));

  it('1. Rewrite: dictated text in, a written prompt read and sent with its job; another job cancelled', async () => {
    const started = await call('POST', `/v1/sessions/${SID}/rewrite`, { text: DICTATED.withMarker });
    expect(started.status, `${started.text}\n${dumpLog()}`).toBe(202);
    const jobId = (started.body as { jobId: string }).jobId;
    const ready = await eventually(async () => {
      const r = await get<RewriteDetail>(`/v1/rewrite/${jobId}`);
      if (r.state === 'failed') throw new Error(`the rewrite failed: ${r.error ?? ''}\n${dumpLog()}`);
      return r.state === 'ready' ? r : null;
    }, 20_000, 'the rewrite to be ready');
    expect(ready.prompt).toContain(REWRITE_MARKER);
    sentPrompt = ready.prompt ?? '';
    const sent = await call('POST', `/v1/sessions/${SID}/prompt`, { text: ready.prompt, onDraft: 'refuse', rewriteJobId: jobId });
    expect(sent.status, sent.text).toBe(202);
    const sendJobId = (sent.body as { jobId: string }).jobId;
    await eventually(async () => d.parts.writer.get(sendJobId)?.stage === 'proven', 20_000, 'the send to be proven');
    expect(terminal.events.enters.at(-1)?.submitted).toBe(ready.prompt);

    const other = await call('POST', `/v1/sessions/${SID}/rewrite`, { text: `${DICTATED.withMarker}, and the tests` });
    expect(other.status, other.text).toBe(202);
    const otherId = (other.body as { jobId: string }).jobId;
    const del = await call('DELETE', `/v1/rewrite/${otherId}`);
    expect(del.status, del.text).toBe(200);
    expect((del.body as { job: RewriteJob }).job.state).toBe('cancelled');
    await eventually(async () => eventTypes().filter((t) => t === 'rewrite.progress').length >= 4, 5_000, 'rewrite.progress on the stream');
  }, perfBudgetMs(60_000));

  it('2. Files: roots, a listing, a text file read, the secret refused', async () => {
    await writeFile(join(cwd, 'NOTES.md'), `# Notes\n\n${FILE_MARKER}\n`);
    await writeFile(join(cwd, '.env'), `TOKEN=${SECRET_MARKER}\n`, { mode: 0o600 });
    const root = encodeURIComponent(`s.${SID}`);
    await get(`/v1/files/roots`);
    await get(`/v1/files/list?root=${root}&hidden=1`);
    const text = await get<{ text: string }>(`/v1/files/text?root=${root}&path=NOTES.md`);
    expect(text.text).toContain(FILE_MARKER);
    for (const route of ['stat', 'text', 'raw']) expect((await call('GET', `/v1/files/${route}?root=${root}&path=.env`)).status).toBe(403);
  });

  it('3. Changed files: a Write and an Edit of the marked content, listed by name and counts only', async () => {
    const file = join(cwd, 'src', 'feature.ts');
    const body = `export const feature = '${FILE_MARKER}';\n`;
    await mkdir(join(cwd, 'src'), { recursive: true });
    await writeFile(file, body);
    const at = new Date().toISOString();
    const ctx = { sessionId: SID, cwd, at };
    await d.home.appendTranscript(SID, [
      assistantToolUse(ctx, 'Write', { file_path: file, content: body }, 'toolu_privacy_w'),
      fileToolResult(ctx, 'toolu_privacy_w', `File created successfully at: ${file}`, { type: 'create', filePath: file, content: body, structuredPatch: [] }),
      assistantToolUse(ctx, 'Edit', { file_path: file, old_string: FILE_MARKER, new_string: `${FILE_MARKER}-2` }, 'toolu_privacy_e'),
      fileToolResult(ctx, 'toolu_privacy_e', 'The file has been updated.', {
        filePath: file,
        oldString: FILE_MARKER,
        newString: `${FILE_MARKER}-2`,
        originalFile: body,
        structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [`-${body.trimEnd()}`, `+${body.trimEnd()}-2`] }],
      }),
    ]);
    const change = await eventually(async () => {
      const r = await get<SessionChangesResponse>(`/v1/sessions/${SID}/changes`);
      const c = r.changes.find((x) => x.path.endsWith('/src/feature.ts'));
      return c && c.ops >= 2 ? c : null;
    }, 20_000, 'the changed file');
    await get(`/v1/sessions/${SID}/changes/${change.changeId}`);
    await get('/v1/files/changes');
    await eventually(async () => eventTypes().includes('files.changed'), 10_000, 'files.changed on the stream');
  });

  it('4. Screen: the text peek, a Shift+Tab at the Mac it publishes, a mode switch and a key from the phone', async () => {
    const peek = await get<{ text: string }>(`/v1/sessions/${SID}/screen?lines=40`);
    expect(peek.text).toContain(SCREEN_MARKER);
    terminal.macShiftTab();
    await get(`/v1/sessions/${SID}/screen?lines=40`);
    await eventually(async () => (await get<SessionsResponse>('/v1/sessions')).sessions.find((s) => s.sid === SID)?.mode === 'acceptEdits', 5_000, 'the mode read off the screen');
    const mode = await call('POST', `/v1/sessions/${SID}/mode`, { mode: 'plan' });
    expect(mode.status, `${mode.text}\n${dumpLog()}`).toBe(200);
    expect(mode.body).toEqual({ mode: 'plan', steps: 1 });
    const key = await call('POST', `/v1/sessions/${SID}/keys`, { key: 'interrupt' });
    expect(key.status, key.text).toBe(200);
  });

  it('5. Launch: a new folder, the preview, the start, the trust card answered from the phone, ready', async () => {
    const made = await call('POST', '/v1/folders', { root: `s.${SID}`, parent: '', name: 'privacy-app' });
    expect(made.status, made.text).toBeLessThan(300);
    const flags: LaunchFlags = { permission: 'acceptEdits', chrome: true, effort: 'high', model: 'sonnet' };
    await get(`/v1/launch/preview?root=${encodeURIComponent(`s.${SID}`)}&path=privacy-app&permission=acceptEdits&chrome=1&effort=high&model=sonnet`);
    const start = await call('POST', '/v1/launches', { root: `s.${SID}`, path: 'privacy-app', account: 'auto', flags }, 'privacy-launch-1');
    expect(start.status, `${start.text}\n${dumpLog()}`).toBe(202);
    const id = (start.body as { job: LaunchJob }).job.id;
    const card = await eventually(async () => {
      const { job } = await get<{ job: LaunchJob }>(`/v1/launches/${id}`);
      if (job.stage === 'failed' || job.stage === 'refused') throw new Error(`the launch ended ${job.stage}: ${job.reason ?? ''}\n${dumpLog()}`);
      return job.stage === 'dialog' ? job : null;
    }, 20_000, 'the trust card');
    const answered = await call('POST', `/v1/launches/${id}/answer`, { option: 0, title: card.dialog?.title });
    expect(answered.status, answered.text).toBeLessThan(300);
    await eventually(async () => {
      const { job } = await get<{ job: LaunchJob }>(`/v1/launches/${id}`);
      if (job.stage === 'failed' || job.stage === 'refused' || job.stage === 'stalled') throw new Error(`the launch ended ${job.stage}: ${job.reason ?? ''}\n${dumpLog()}`);
      return job.stage === 'done';
    }, 45_000, 'the launch to be done');
    // The launch window's screens did carry the marker (its top line).
    expect(terminal.launch?.screen()).toContain(SCREEN_MARKER);
  }, perfBudgetMs(90_000));

  it('6. the sweep: no marker in a frame, the ring, the stored events, the audit, a log line, a push, a launch row or a write reply', async () => {
    // Let the last events reach the socket.
    await eventually(async () => eventTypes().includes('launch.progress'), 5_000, 'launch.progress on the stream');
    const types = new Set(eventTypes());
    for (const t of ['rewrite.progress', 'send.progress', 'files.changed', 'session.updated', 'launch.progress']) expect(types.has(t), t).toBe(true);

    const replay = d.ctx.store.replay(0);
    expect(replay.kind).toBe('events'); // the whole run is still in the 2,000-event ring
    const ring = replay.kind === 'events' ? replay.events : [];
    const sources: Record<string, unknown> = {
      'WS frames': frames.map((f) => withoutSentPrompt(JSON.parse(f), sentPrompt)),
      'event ring': withoutSentPrompt(ring, sentPrompt),
      'stored events': withoutSentPrompt(d.ctx.db.events.since(0), sentPrompt),
      'audit rows': d.ctx.db.audit.list({ after: 0, limit: 100_000 }),
      'log lines': d.log.records,
      pushes: d.pushed,
      'launch rows': d.ctx.db.launches.list({ limit: 1000 }),
      'write replies': writes,
    };
    for (const [what, value] of Object.entries(sources)) expect(markersIn(value), what).toEqual([]);
    expect(frames.length).toBeGreaterThan(20);
    expect(ring.length).toBeGreaterThan(20);
    expect(writes.length).toBeGreaterThanOrEqual(8);

    // The reads carried what they were asked for, so every marker but the secret was in play...
    const readText = reads.map((r) => r.text);
    expect(markersIn(readText, PRIVACY_MARKERS)).toEqual([REWRITE_MARKER, FILE_MARKER, SCREEN_MARKER]);
    // ...and only where it belongs: the changes list and its ops name files and counts, never their content.
    const changeReads = reads.filter((r) => r.what.includes('/changes'));
    expect(changeReads.length).toBeGreaterThanOrEqual(3);
    expect(markersIn(changeReads)).toEqual([]);
  });
});
